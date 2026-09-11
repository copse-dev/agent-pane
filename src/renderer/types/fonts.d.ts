// esbuild emits a URL for the application and base64 for the isolated diagram
// bundle. Both representations are strings; the importing entry owns decoding.
declare module '*.ttf' {
  const source: string
  export default source
}
