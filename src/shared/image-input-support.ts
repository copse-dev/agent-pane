export const IMAGE_INPUT_UNSUPPORTED_MESSAGE =
  'The selected model has no endpoint that supports image input. Choose an image-capable model in the composer and Resend, or use Resend without image on your prompt.'

export function isImageInputUnsupportedMessage(text: string): boolean {
  return text.startsWith(IMAGE_INPUT_UNSUPPORTED_MESSAGE)
}
