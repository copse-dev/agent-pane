import { contextBridge, ipcRenderer } from 'electron'
import {
  VIDEO_DECODE_READY_CHANNEL,
  VIDEO_DECODE_REQUEST_CHANNEL,
  VIDEO_DECODE_RESULT_CHANNEL,
  type DecodeFramesRequest,
  type DecodeFramesResponse,
  type VideoDecoderBridge,
} from '@shared/video/decode-contract.ts'

/**
 * Preload for the hidden video-decoder window. Deliberately tiny: the decoder
 * page has no user input, no navigation and no access to the app's API surface —
 * it receives a buffer, hands back frames, and can do nothing else.
 */
const api: VideoDecoderBridge = {
  onRequest(handler: (request: DecodeFramesRequest) => void): void {
    ipcRenderer.on(VIDEO_DECODE_REQUEST_CHANNEL, (_event, request: DecodeFramesRequest) => {
      handler(request)
    })
  },
  respond(response: DecodeFramesResponse): void {
    ipcRenderer.send(VIDEO_DECODE_RESULT_CHANNEL, response)
  },
  ready(): void {
    ipcRenderer.send(VIDEO_DECODE_READY_CHANNEL)
  },
}

contextBridge.exposeInMainWorld('videoDecoder', api)
