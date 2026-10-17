<script lang="ts">
import { faFileLines } from '@fortawesome/free-regular-svg-icons';
import {
  faArrowTurnDown,
  faHashtag,
  faMagnifyingGlass,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import { docHref } from '#lib/links.js';
import { type SearchEntry, type SearchResult, search } from '#lib/search.js';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import Icon from './Icon.svelte';

let dialog = $state<HTMLDialogElement>();
let input = $state<HTMLInputElement>();
let list = $state<HTMLUListElement>();
let query = $state('');
let active = $state(0);
let entries = $state<SearchEntry[]>();
let failed = $state(false);
let loading = $state(false);
let isMac = $state(false);

const results: SearchResult[] = $derived(entries ? search(entries, query) : []);
const trimmed = $derived(query.trim());

const resultHref = (r: SearchResult) => docHref(r.slug, r.hash);

$effect(() => {
  isMac = /Mac|iPhone|iPad/.test(navigator.platform);
});

async function load() {
  if (entries || loading) return;
  loading = true;
  failed = false;
  try {
    const res = await fetch(resolve('/search.json'));
    if (!res.ok) throw new Error(String(res.status));
    entries = await res.json();
  } catch {
    failed = true;
  } finally {
    loading = false;
  }
}

function open() {
  dialog?.showModal();
  input?.select();
  void load();
}

function close() {
  dialog?.close();
}

function choose(result: SearchResult | undefined) {
  if (!result) return;
  close();
  void goto(resultHref(result));
}

function move(delta: number) {
  if (!results.length) return;
  active = (active + delta + results.length) % results.length;
  list?.children[active]?.scrollIntoView({ block: 'nearest' });
}

function onInputKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    choose(results[active]);
  }
}

function onWindowKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = target?.closest('input, textarea, select, [contenteditable="true"]');
  if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
    event.preventDefault();
    open();
  }
}

$effect(() => {
  void query;
  active = 0;
});
</script>

<svelte:window onkeydown={onWindowKey} />

<button class="trigger" type="button" onclick={open} aria-label="Search the documentation">
  <Icon icon={faMagnifyingGlass} size="0.85rem" />
  <span class="label">Search docs</span>
  <span class="keys" aria-hidden="true"><kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>K</kbd></span>
</button>

<dialog
  bind:this={dialog}
  aria-label="Search the documentation"
  onclick={(event) => {
    if (event.target === dialog) close();
  }}
>
  <div class="panel">
    <div class="field">
      <Icon icon={faMagnifyingGlass} size="0.95rem" class="field-icon" />
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onInputKey}
        type="search"
        placeholder="Search guides, packages and APIs"
        aria-label="Search query"
        aria-controls="search-results"
        aria-activedescendant={results.length ? `search-result-${active}` : undefined}
        autocomplete="off"
        spellcheck="false"
      />
      <button class="esc" type="button" onclick={close} aria-label="Close search"><kbd>Esc</kbd></button>
    </div>

    {#if failed}
      <div class="state error" role="alert">
        <Icon icon={faTriangleExclamation} size="1rem" />
        <div>
          <p>The search index did not load.</p>
          <button type="button" class="retry" onclick={load}>Try again</button>
        </div>
      </div>
    {:else if loading}
      <ul class="results" aria-hidden="true">
        {#each [0, 1, 2] as i (i)}
          <li class="skeleton"><span></span><span></span></li>
        {/each}
      </ul>
    {:else if trimmed && !results.length}
      <div class="state">
        <p>No pages or sections match “{trimmed}”.</p>
        <p class="hint">Try an API name such as <code>inject</code>, <code>JsonLogger</code> or <code>@Cron</code>.</p>
      </div>
    {:else if !trimmed}
      <div class="state">
        <p class="hint">Search every guide and package page, down to section headings.</p>
      </div>
    {:else}
      <ul bind:this={list} id="search-results" class="results" role="listbox" aria-label="Results">
        {#each results as result, i (resultHref(result))}
          <li
            id="search-result-{i}"
            role="option"
            aria-selected={i === active}
            style:--i={Math.min(i, 8)}
          >
            <a
              href={resultHref(result)}
              class:active={i === active}
              onclick={(event) => {
                event.preventDefault();
                choose(result);
              }}
              onmousemove={() => (active = i)}
            >
              <span class="kind"><Icon icon={result.hash ? faHashtag : faFileLines} size="0.85rem" /></span>
              <span class="text">
                <span class="title">
                  {#if result.context}<span class="context">{result.context}</span>{/if}
                  {result.title}
                </span>
                {#if result.excerpt}<span class="excerpt">{result.excerpt}</span>{/if}
              </span>
              <span class="go" aria-hidden="true"><Icon icon={faArrowTurnDown} size="0.75rem" /></span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}

    <footer class="foot" aria-hidden="true">
      <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
      <span><kbd>Enter</kbd> open</span>
      <span><kbd>Esc</kbd> close</span>
    </footer>
  </div>
</dialog>

<style>
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    height: 2.35rem;
    min-width: 13.5rem;
    margin-right: 0.35rem;
    padding: 0 0.4rem 0 0.8rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-raised);
    color: var(--fg-muted);
    font: inherit;
    font-size: 0.86rem;
    cursor: pointer;
    transition:
      border-color 0.2s var(--ease-out),
      color 0.2s var(--ease-out),
      box-shadow 0.25s var(--ease-out);
  }

  .trigger:hover {
    border-color: var(--border-strong);
    color: var(--fg-soft);
    box-shadow: var(--shadow-lift);
  }

  .keys {
    display: inline-flex;
    gap: 0.2rem;
    margin-left: auto;
  }

  @media (max-width: 720px) {
    .trigger {
      min-width: 0;
      width: 2.75rem;
      height: 2.75rem;
      margin: 0;
      padding: 0;
      justify-content: center;
      border-color: transparent;
      background: none;
    }

    .label,
    .keys {
      display: none;
    }
  }

  dialog {
    width: min(42rem, calc(100vw - 2rem));
    max-height: min(38rem, calc(100dvh - 6rem));
    margin: 5.5rem auto auto;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    background: var(--bg-raised);
    color: var(--fg);
    box-shadow: var(--shadow-pop);
  }

  dialog[open] {
    animation: dialog-in 0.32s var(--ease-out);
  }

  dialog::backdrop {
    background: oklch(0.2 0.02 50 / 0.42);
    backdrop-filter: blur(3px);
  }

  @keyframes dialog-in {
    from {
      opacity: 0;
      transform: translateY(-10px) scale(0.98);
    }
  }

  .panel {
    display: flex;
    flex-direction: column;
    max-height: inherit;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.75rem 0 1.15rem;
    border-bottom: 1px solid var(--border);
    color: var(--fg-muted);
  }

  input {
    flex: 1;
    min-width: 0;
    padding: 1.05rem 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 1.05rem;
  }

  input::-webkit-search-cancel-button {
    display: none;
  }

  .esc {
    padding: 0.3rem;
    border: 0;
    background: none;
    cursor: pointer;
  }

  .results {
    margin: 0;
    padding: 0.5rem;
    overflow-y: auto;
    list-style: none;
  }

  .results li {
    animation: row-in 0.35s var(--ease-out) both;
    animation-delay: calc(var(--i, 0) * 22ms);
  }

  @keyframes row-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }

  .results a {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.8rem;
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius);
    color: var(--fg);
    text-decoration: none;
  }

  .results a.active {
    background: var(--accent-soft);
  }

  .kind {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--bg);
    color: var(--fg-muted);
  }

  .active .kind {
    border-color: color-mix(in oklch, var(--accent) 35%, var(--border));
    color: var(--accent-ink);
  }

  .text {
    min-width: 0;
  }

  .title {
    display: block;
    overflow: hidden;
    font-size: 0.93rem;
    font-weight: 560;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context {
    margin-right: 0.4rem;
    color: var(--fg-muted);
    font-weight: 400;
  }

  .context::after {
    content: ' /';
  }

  .excerpt {
    display: block;
    overflow: hidden;
    color: var(--fg-muted);
    font-size: 0.82rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .go {
    color: var(--accent-ink);
    opacity: 0;
    transform: rotate(90deg) translateY(-3px);
    transition:
      opacity 0.2s var(--ease-out),
      transform 0.3s var(--ease-out);
  }

  .active .go {
    opacity: 1;
    transform: rotate(90deg);
  }

  .skeleton {
    display: grid;
    gap: 0.45rem;
    padding: 0.85rem 0.75rem 0.85rem 3.55rem;
  }

  .skeleton span {
    height: 0.7rem;
    border-radius: 4px;
    background: linear-gradient(90deg, var(--bg-sunken), var(--border), var(--bg-sunken));
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }

  .skeleton span:first-child {
    width: 45%;
  }

  .skeleton span:last-child {
    width: 75%;
  }

  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }

  .state {
    padding: 1.4rem 1.3rem;
    color: var(--fg-soft);
    font-size: 0.92rem;
  }

  .state p {
    margin: 0;
  }

  .state .hint {
    margin-top: 0.3rem;
    color: var(--fg-muted);
    font-size: 0.86rem;
  }

  .state.error {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    color: var(--caution);
  }

  .retry {
    margin-top: 0.5rem;
    padding: 0.35rem 0.8rem;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
    font-size: 0.84rem;
    cursor: pointer;
  }

  .foot {
    display: flex;
    gap: 1.1rem;
    padding: 0.6rem 1.15rem;
    border-top: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--fg-muted);
    font-size: 0.75rem;
  }

  .foot kbd {
    margin-right: 0.2rem;
  }

  @media (max-width: 520px) {
    .foot {
      display: none;
    }
  }
</style>
