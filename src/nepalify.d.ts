/**
 * Minimal types for nepalify 0.5.0, which ships no declarations.
 * Mirrors src/index.js: { format, availableLayouts, interceptElementById }.
 */
declare module 'nepalify' {
  export type NepaliLayout = 'romanized' | 'traditional';

  export interface Interceptor {
    el: HTMLElement;
    enable(): void;
    disable(): void;
    isEnabled(): boolean;
  }

  const nepalify: {
    format(text: string, options?: { layout?: NepaliLayout }): string;
    availableLayouts(): NepaliLayout[];
    interceptElementById(
      id: string,
      options?: { layout?: NepaliLayout; enable?: boolean },
    ): Interceptor;
  };

  export default nepalify;
}
