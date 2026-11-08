// Vite turns image imports into URLs.
declare module '*.png' {
  const url: string
  export default url
}
