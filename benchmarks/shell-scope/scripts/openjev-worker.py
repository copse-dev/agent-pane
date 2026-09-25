"""Pinned OpenJev NLI backend using the existing JSONL boundary; never executes commands."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

source = Path(__file__).resolve().with_name('roadmap-model-worker.py')
spec = importlib.util.spec_from_file_location('native_boundary', source)
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)


def load_openjev(args):
    import torch
    import transformers
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    if args.model != 'AlexWortega/openjev' or args.revision != '4b5f9a67fa2ebe77466bce0656ce350effc3148c':
        raise ValueError('OpenJev identity must match the frozen checkpoint')
    if args.device == 'mps' and not torch.backends.mps.is_available():
        raise RuntimeError('mps-unavailable')
    subfolder = 'qwen3.5-4b-nli-v2'
    revision = args.revision
    directory = Path(args.cache_dir) / 'models--AlexWortega--openjev' / 'snapshots' / revision / subfolder
    if not directory.is_dir() or not list(directory.glob('*.safetensors')):
        raise RuntimeError('Pinned local OpenJev snapshot is incomplete')
    tokenizer = AutoTokenizer.from_pretrained(directory, trust_remote_code=False, local_files_only=True)
    dtype = torch.bfloat16 if args.device == 'mps' else torch.float32
    model = AutoModelForSequenceClassification.from_pretrained(directory, trust_remote_code=False, local_files_only=True, dtype=dtype).to(args.device).eval()
    if model.config.num_labels != 3:
        raise ValueError('Expected published three-way NLI classifier')
    template = getattr(model.config, 'nli_template', None) or 'Premise: {premise}\nHypothesis: {hypothesis}'
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = 'right'
    text_config = model.config.get_text_config()
    if text_config.pad_token_id is None:
        text_config.pad_token_id = tokenizer.pad_token_id
    details = {
        'python': sys.version.split()[0], 'torch': torch.__version__, 'transformers': transformers.__version__,
        'device': args.device, 'dtype': str(dtype), 'revision': revision, 'subfolder': subfolder,
        'templateHash': hashlib.sha256(template.encode()).hexdigest(),
        'id2label': json.dumps(model.config.id2label, sort_keys=True),
        'decisionRule': 'argmax per-hypothesis entailment index 1; no categorical confidence',
        'offline': True, 'boundaryHash': hashlib.sha256(source.read_bytes()).hexdigest(),
        'adapter': 'openjev-worker.py; same NLI text/template/decision rule; new compatible cached runtime and explicit MPS BF16',
    }

    def predict(payload):
        question = payload['questions']['resolution']
        premise = json.dumps(payload, ensure_ascii=False)
        names = list(question['criteria'])
        texts = [template.format(premise=premise, hypothesis='The correct answer is: ' + name + '. ' + question['criteria'][name]) for name in names]
        lengths = [len(tokenizer(text, truncation=False)['input_ids']) for text in texts]
        if max(lengths) > 4096:
            raise boundary.ContextOverflow('OpenJev input exceeds 4096 tokens')
        encoded = tokenizer(texts, truncation=False, padding=True, return_tensors='pt').to(args.device)
        with torch.inference_mode():
            logits = model(**encoded).logits.float()
            if tuple(logits.shape) != (len(names), 3) or not torch.isfinite(logits).all():
                raise ValueError('Invalid native NLI logits')
            scores = logits.softmax(-1)[:, 1].cpu().tolist()
        winner = max(range(len(scores)), key=scores.__getitem__)
        return names[winner], None, {'input_tokens': sum(lengths)}, {
            **{'entailment_' + name: score for name, score in zip(names, scores)},
            'decisionRule': 'argmax entailment; scores not normalized across verdicts',
        }
    return args.model + '@' + revision + '/' + subfolder, details, predict


import traceback
_original_safe_error = boundary.safe_error
def diagnostic_error(error):
    frames = ' -> '.join(Path(frame.filename).name + ':' + str(frame.lineno) + ':' + frame.name for frame in traceback.extract_tb(error.__traceback__)[-6:])
    return _original_safe_error(error) + ' [' + frames + ']'
boundary.safe_error = diagnostic_error
boundary.load_backend = load_openjev
raise SystemExit(boundary.main())
