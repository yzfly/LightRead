/** 构建期由 vite define 注入的应用版本号 (取自 package.json) */
declare const __APP_VERSION__: string
/** 构建平台 (TAURI_ENV_PLATFORM): android / ios / linux / macos / windows; 网页版为 web */
declare const __APP_PLATFORM__: string
/** 模拟器验收遥控端地址 (LIGHTREAD_E2E_DRIVER); 正式构建为空串 */
declare const __E2E_DRIVER__: string

// foliate-js 无类型定义, 按需声明
declare module 'foliate-js/view.js' {
  export function makeBook(file: File | string): Promise<any>
  export class ResponseError extends Error {}
  export class NotFoundError extends Error {}
  export class UnsupportedTypeError extends Error {}
}

declare module 'foliate-js/epub.js' {
  export class EPUB {
    constructor(loader: {
      loadText: (name: string) => Promise<string | null> | string | null
      loadBlob: (name: string, type?: string) => Promise<Blob | null> | Blob | null
      getSize: (name: string) => number
      sha1?: (s: string) => Promise<Uint8Array>
    })
    init(): Promise<any>
  }
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

declare module 'foliate-js/progress.js' {
  export class TOCProgress {
    init(opts: { toc: unknown[]; ids: string[]; splitHref: (href: string) => unknown; getFragment: (doc: Document, id: string) => Element | null }): Promise<void>
    getProgress(index: number, range?: Range): { label?: string; href?: string } | null | undefined
  }
}

declare module 'foliate-js/epubcfi.js' {
  export function compare(a: string | unknown, b: string | unknown): number
  export function parse(cfi: string): unknown
  export function collapse(cfi: string, toEnd?: boolean): string
  export const isCFI: RegExp
}
