import { defineConfig } from 'astro/config';

// Fully static output. The synthesis call goes from the browser straight to the
// Hugging Face Space (which already sends CORS: *), NOT through Vercel -- a Hobby
// function caps at 60s and synthesis can take longer than that.
// The only serverless function here is api/warm.js, a cron-driven keep-alive ping.
export default defineConfig({
  output: 'static',
  site: 'https://nepali-voice-cloning.vercel.app',
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
