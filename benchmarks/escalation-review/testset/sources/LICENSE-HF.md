# Licences for the Hugging Face samples

`hf-shell-safety-v2.jsonl` and `hf-nl2sh-alfa.jsonl` contain commands sampled from two MIT-licensed
datasets. `sample-hf.mjs` records the pinned revisions. These are the changes we made:

- we kept a subset of rows;
- in shell-safety-v2 we renamed the ssh user `tom@` to `dev@`;
- in NL2SH-ALFA we moved `/testbed` to `/Users/dev/project`.

Each row's `source` names its dataset, revision and row index.

## tomngdev/shell-safety-v2

https://huggingface.co/datasets/tomngdev/shell-safety-v2, revision
`3258db497dae218f23d1d648ef2eb7cb6ab5e70c`. The dataset card declares `license: mit`, and the
repository publishes no separate licence file.

Copyright (c) tomngdev

## westenfelder/NL2SH-ALFA

https://huggingface.co/datasets/westenfelder/NL2SH-ALFA, revision
`a99cb5784cf5c2a42b1cc26c1903d9c3b35206ba`. Westenfelder et al., "LLM-Supported Natural Language
to Bash Translation", arXiv:2502.06858.

Copyright 2025 MIT-ALFA

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
