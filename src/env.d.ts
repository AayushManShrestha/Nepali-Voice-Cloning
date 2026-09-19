/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Override the model server origin, e.g. http://localhost:7860 for local testing. */
  readonly PUBLIC_SPACE_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
