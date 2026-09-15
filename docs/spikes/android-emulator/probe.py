"""Disposable-AVD gRPC spike. Requires grpcio, protobuf and a protoc descriptor set.

See ../android-emulator.md. No Copse runtime integration; never prints the auth token.
Input tests require --exercise-input and change only the selected emulator's screen.
"""
import argparse
import hashlib
import json
from pathlib import Path
import threading
import time

import grpc
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--descriptor', type=Path, required=True)
parser.add_argument('--discovery', type=Path, required=True)
parser.add_argument('--port', type=int, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--exercise-input', action='store_true')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
pool = descriptor_pool.DescriptorPool()
for file in descriptor_pb2.FileDescriptorSet.FromString(args.descriptor.read_bytes()).file:
    pool.Add(file)


def message(name, **values):
    prefix = 'google.protobuf.' if name == 'Empty' else 'android.emulation.control.'
    cls = message_factory.GetMessageClass(pool.FindMessageTypeByName(prefix + name))
    return cls(**values)


info = {}
for line in args.discovery.read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        info[key.strip()] = value.strip()
if int(info['grpc.port']) != args.port:
    raise ValueError('Discovery file does not match requested port')
metadata = [('authorization', 'Bearer ' + info['grpc.token'])]
channel = grpc.insecure_channel(
    f'127.0.0.1:{args.port}',
    options=[('grpc.max_receive_message_length', 32 * 1024 * 1024)],
)
base = '/android.emulation.control.EmulatorController/'


def call(name, request, response='Empty', auth=True):
    method = channel.unary_unary(
        base + name,
        request_serializer=lambda value: value.SerializeToString(),
        response_deserializer=type(message(response)).FromString,
    )
    return method(request, timeout=10, metadata=metadata if auth else [])


def screenshot(name):
    start = time.monotonic()
    image = call('getScreenshot', message('ImageFormat', width=540, height=960), 'Image')
    if not image.image.startswith(b'\x89PNG'):
        raise ValueError('No PNG frame received')
    (args.output / (name + '.png')).write_bytes(image.image)
    return {
        'width': image.format.width, 'height': image.format.height,
        'bytes': len(image.image), 'rpc_ms': round((time.monotonic() - start) * 1000, 1),
        'sha256': hashlib.sha256(image.image).hexdigest(),
    }


def key(value):
    call('sendKey', message('KeyboardEvent', key=value, eventType=2))


def touch(x, y, pressure):
    call('sendTouch', message('TouchEvent', touches=[message('Touch', x=x, y=y, pressure=pressure, identifier=0)]))


def stream_sample(pixel_format):
    method = channel.unary_stream(
        base + 'streamScreenshot',
        request_serializer=lambda value: value.SerializeToString(),
        response_deserializer=type(message('Image')).FromString,
    )
    start = time.monotonic()
    stream = method(message('ImageFormat', format=pixel_format, width=540, height=960), timeout=8, metadata=metadata)
    timer = threading.Timer(4, stream.cancel)
    timer.start()
    sizes, seqs, first_ms = [], [], None
    try:
        for frame in stream:
            if first_ms is None:
                first_ms = round((time.monotonic() - start) * 1000, 1)
            sizes.append(len(frame.image))
            seqs.append(frame.seq)
    except grpc.RpcError as error:
        if error.code() != grpc.StatusCode.CANCELLED:
            raise
    finally:
        timer.cancel()
        stream.cancel()
    elapsed = time.monotonic() - start
    return {'frames': len(sizes), 'empty_frames': sizes.count(0), 'seconds': round(elapsed, 2),
            'fps_observed': round(len(sizes) / elapsed, 1), 'bytes': sum(sizes),
            'first_frame_ms': first_ms, 'first_seq': seqs[:1], 'last_seq': seqs[-1:]}


report = {}
try:
    try:
        call('getStatus', message('Empty'), 'EmulatorStatus', auth=False)
        raise RuntimeError('Endpoint accepted a request without authentication')
    except grpc.RpcError as error:
        report['without_token'] = error.code().name
        if error.code() != grpc.StatusCode.UNAUTHENTICATED:
            raise
    report['version'] = call('getStatus', message('Empty'), 'EmulatorStatus').version
    report['initial'] = screenshot('initial')
    if args.exercise_input:
        # Precondition: disposable spike Activity at 1080x1920, initially Taps: 0.
        touch(500, 350, 1)
        time.sleep(0.1)
        touch(500, 350, 0)
        time.sleep(3)
        touch(300, 470, 1)
        time.sleep(0.1)
        touch(300, 470, 0)
        time.sleep(3)
        call('sendKey', message('KeyboardEvent', text='copse123', eventType=2))
        time.sleep(3)
        report['app_input'] = screenshot('app-input')
        # Screenshot inspection, not RPC success, establishes delivery.
        key('GoBack')
        time.sleep(1)
    report['png_stream_idle'] = stream_sample(0)
    report['rgba_stream_idle'] = stream_sample(1)
    if args.exercise_input:
        stop = threading.Event()
        errors = []
        def animate():
            try:
                while not stop.wait(0.5):
                    key('AppSwitch')
                    if stop.wait(0.5):
                        break
                    key('GoHome')
            except Exception as error:
                errors.append(str(error))
        worker = threading.Thread(target=animate)
        worker.start()
        try:
            report['png_stream_animated'] = stream_sample(0)
            report['rgba_stream_animated'] = stream_sample(1)
        finally:
            stop.set()
            worker.join(timeout=12)
        if errors:
            raise RuntimeError(errors)
        key('GoHome')
    report['after_stream_cancel'] = screenshot('after-cancel')
finally:
    channel.close()
(args.output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
