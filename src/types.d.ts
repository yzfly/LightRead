/** 构建期由 vite define 注入的应用版本号 (取自 package.json) */
declare const __APP_VERSION__: string

// foliate-js 无类型定义, 按需声明
declare module 'foliate-js/view.js' {
  export function makeBook(file: File | string): Promise<any>
  export class ResponseError extends Error {}
  export class NotFoundError extends Error {}
  export class UnsupportedTypeError extends Error {}
}

declare module 'foliate-js/overlayer.js' {
  export class Overlayer {
    static highlight: unknown
    static underline: unknown
    static squiggly: unknown
  }
}

declare module 'foliate-js/opds.js' {
  export const REL: Record<string, any>
  export const SYMBOL: { SUMMARY: symbol; CONTENT: symbol; PAGINATION: symbol }
  export function isOPDSCatalog(str: string): boolean
  export function getPublication(entry: Element): any
  export function getFeed(doc: Document): any
  export function getSearch(link: any): Promise<any>
  export function getOpenSearch(doc: Document): any
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
