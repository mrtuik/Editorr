/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' when the app is built with the optional YouTube music module. */
  readonly VITE_YOUTUBE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
