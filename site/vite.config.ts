import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// GitHub Pages serves the site from /<repo>/; CI sets BASE_PATH=/knead. Local dev uses the root.
const base = process.env.BASE_PATH ?? '';
if (base !== '' && !/^\/[\w.-]+(?:\/[\w.-]+)*$/.test(base)) {
  throw new Error(`BASE_PATH must look like /knead (got ${JSON.stringify(base)})`);
}

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: { runes: true },
      adapter: adapter({ pages: 'build', assets: 'build', fallback: '404.html', strict: true }),
      // Absolute links: rendered markdown is cached and shared by every page that renders it.
      paths: { base: base as '' | `/${string}`, relative: false },
      prerender: {
        // Broken internal links and missing #fragments fail the build.
        handleHttpError: 'fail',
        handleMissingId: 'fail',
        handleUnseenRoutes: 'fail',
      },
    }),
  ],
});
