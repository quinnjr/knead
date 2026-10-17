<script lang="ts">
import { faArrowLeft, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons';
import Icon from '#lib/components/Icon.svelte';
import { docHref } from '#lib/links.js';
import { resolve } from '$app/paths';
import { page } from '$app/state';

const missing = $derived(page.status === 404);

function openSearch() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
}
</script>

<svelte:head>
  <title>{missing ? 'Page not found' : 'Something went wrong'} · Knead</title>
</svelte:head>

<div class="error">
  <p class="status">{page.status}</p>
  <h1>{missing ? 'This page is not in the docs.' : 'Something went wrong.'}</h1>
  <p class="lead">
    {#if missing}
      The link may point at a page that moved. Search for what you were after, or start from the
      introduction.
    {:else}
      {page.error?.message}
    {/if}
  </p>
  <div class="actions">
    {#if missing}
      <button type="button" class="button primary" onclick={openSearch}>
        <Icon icon={faMagnifyingGlass} size="0.85rem" /> Search the docs
      </button>
      <a class="button" href={docHref('guide/introduction')}>Introduction</a>
    {/if}
    <a class="button ghost" href={resolve('/')}><Icon icon={faArrowLeft} size="0.8rem" /> Home</a>
  </div>
</div>

<style>
  .error {
    max-width: 40rem;
    margin: 0 auto;
    padding: 7rem 1.5rem 6rem;
  }

  .status {
    margin: 0;
    color: var(--accent-ink);
    font-family: var(--font-mono);
    font-size: 0.8rem;
    letter-spacing: 0.1em;
  }

  h1 {
    margin: 0.5rem 0 1rem;
    font-family: var(--font-display);
    font-size: clamp(2.4rem, 6vw, 3.6rem);
    font-weight: 400;
    line-height: 1.02;
    letter-spacing: -0.02em;
  }

  .lead {
    max-width: 52ch;
    margin: 0 0 2rem;
    color: var(--fg-soft);
    font-size: 1.08rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .button {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0 1.15rem;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--bg-raised);
    color: var(--fg);
    font: inherit;
    font-size: 0.92rem;
    font-weight: 560;
    text-decoration: none;
    cursor: pointer;
    transition:
      transform 0.3s var(--ease-out),
      box-shadow 0.3s var(--ease-out);
  }

  .button:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-lift);
  }

  .button:active {
    transform: translateY(0) scale(0.98);
  }

  .button.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-contrast);
  }

  .button.ghost {
    border-style: dashed;
    background: none;
  }
</style>
