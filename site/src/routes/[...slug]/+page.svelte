<script lang="ts">
import { faPenToSquare } from '@fortawesome/free-regular-svg-icons';
import { faArrowLeft, faArrowRight, faCube } from '@fortawesome/free-solid-svg-icons';
import Icon from '#lib/components/Icon.svelte';
import { docHref } from '#lib/links.js';
import { NAV } from '#lib/nav.js';
import { afterNavigate } from '$app/navigation';
import type { PageProps } from './$types';

let { data }: PageProps = $props();

const order = NAV.flatMap((section) => section.slugs);
const titles = $derived(
  new Map(data.nav.flatMap((s) => s.links.map((l): [string, string] => [l.slug, l.title]))),
);
const index = $derived(order.indexOf(data.slug));
const prev = $derived(index > 0 ? order[index - 1] : undefined);
const next = $derived(index >= 0 && index < order.length - 1 ? order[index + 1] : undefined);
const section = $derived(NAV.find((s) => s.slugs.includes(data.slug))?.title);
const packageName = $derived(
  data.slug.startsWith('packages/')
    ? `@knead-js/${data.slug.slice('packages/'.length)}`
    : undefined,
);
const editUrl = $derived(
  `https://github.com/quinnjr/knead/edit/develop/site/content/${data.slug}.md`,
);

let article = $state<HTMLElement>();
let activeId = $state<string>();

// Scroll spy: the active entry is the last heading that has scrolled past the top band.
$effect(() => {
  void data.slug;
  const root = article;
  if (!root || data.toc.length < 2) return;
  const headings = data.toc
    .map((entry) => document.getElementById(entry.id))
    .filter((el): el is HTMLElement => el !== null);
  activeId = data.toc[0]?.id;
  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        if (record.isIntersecting) visible.add(record.target.id);
        else visible.delete(record.target.id);
      }
      const firstVisible = headings.find((h) => visible.has(h.id));
      if (firstVisible) {
        activeId = firstVisible.id;
        return;
      }
      // Between headings: keep the last one above the viewport.
      const above = headings.filter((h) => h.getBoundingClientRect().top < 0);
      activeId = above.at(-1)?.id ?? headings[0]?.id;
    },
    { rootMargin: '-64px 0px -55% 0px' },
  );
  for (const heading of headings) observer.observe(heading);
  return () => observer.disconnect();
});

let navigations = $state(0);
afterNavigate(() => {
  navigations++;
});

// Copy buttons on code blocks (rendered at build time; one delegated listener here).
function copyCode(node: HTMLElement) {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const onClick = async (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button.copy');
    if (!button) return;
    const label = button.querySelector('.copy-label');
    const code = button.closest('.code-block')?.querySelector('pre')?.innerText ?? '';
    try {
      await navigator.clipboard.writeText(code.replace(/\n$/, ''));
      if (label) label.textContent = 'Copied';
      button.dataset.copied = '';
    } catch {
      if (label) label.textContent = 'Select and copy';
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (label) label.textContent = 'Copy';
      delete button.dataset.copied;
    }, 1600);
    timers.add(timer);
  };
  node.addEventListener('click', onClick);
  return {
    destroy() {
      node.removeEventListener('click', onClick);
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
</script>

<svelte:head>
  <title>{data.title} · Knead</title>
  <meta name="description" content={data.description} />
  <meta property="og:title" content="{data.title} · Knead" />
  <meta property="og:description" content={data.description} />
</svelte:head>

<div class="page">
  {#key navigations}
    <article class="content" bind:this={article}>
      <header class="page-head">
        {#if section}<p class="eyebrow">{section}</p>{/if}
        <h1>{data.title}</h1>
        <p class="lead">{data.description}</p>
        <div class="meta">
          {#if packageName}
            <a class="chip" href="https://www.npmjs.com/package/{packageName}" rel="noreferrer">
              <Icon icon={faCube} size="0.8rem" />
              <span>{packageName}</span>
            </a>
          {/if}
          <a class="chip ghost" href={editUrl} rel="noreferrer">
            <Icon icon={faPenToSquare} size="0.8rem" />
            <span>Edit this page</span>
          </a>
        </div>
      </header>
      <div class="prose" use:copyCode>
        <!-- Rendered at build time from this repository's markdown; never user input. -->
        {@html data.html}
      </div>
      <nav class="pager" aria-label="Previous and next pages">
        {#if prev}
          <a class="prev" href={docHref(prev)}>
            <span class="dir"><Icon icon={faArrowLeft} size="0.75rem" /> Previous</span>
            <span class="name">{titles.get(prev)}</span>
          </a>
        {/if}
        {#if next}
          <a class="next" href={docHref(next)}>
            <span class="dir">Next <Icon icon={faArrowRight} size="0.75rem" /></span>
            <span class="name">{titles.get(next)}</span>
          </a>
        {/if}
      </nav>
    </article>
  {/key}
  {#if data.toc.length > 1}
    <aside class="toc" aria-label="On this page">
      <p class="toc-title">On this page</p>
      <ul>
        {#each data.toc as entry (entry.id)}
          <li class:sub={entry.depth === 3}>
            <a
              href="#{entry.id}"
              class:active={activeId === entry.id}
              aria-current={activeId === entry.id ? 'location' : undefined}>{entry.text}</a
            >
          </li>
        {/each}
      </ul>
    </aside>
  {/if}
</div>

<style>
  .page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--toc-w);
    gap: 3.5rem;
    padding: 2.75rem 2.75rem 5rem 3.5rem;
  }

  .content {
    min-width: 0;
    max-width: 48rem;
    animation: page-in 0.5s var(--ease-out);
  }

  @keyframes page-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
  }

  .page-head {
    padding-bottom: 1.75rem;
    margin-bottom: 2rem;
    border-bottom: 1px solid var(--border);
  }

  .eyebrow {
    margin: 0 0 0.7rem;
    color: var(--accent-ink);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0 0 0.75rem;
    color: var(--fg);
    font-family: var(--font-display);
    font-size: clamp(2.4rem, 4.2vw, 3.3rem);
    font-weight: 400;
    line-height: 1.04;
    letter-spacing: -0.015em;
    text-wrap: balance;
  }

  .lead {
    max-width: 60ch;
    margin: 0;
    color: var(--fg-soft);
    font-size: 1.12rem;
    line-height: 1.6;
    text-wrap: pretty;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1.25rem;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 2rem;
    padding: 0 0.75rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-raised);
    color: var(--fg-soft);
    font-family: var(--font-mono);
    font-size: 0.76rem;
    text-decoration: none;
    transition:
      border-color 0.2s var(--ease-out),
      color 0.2s var(--ease-out),
      transform 0.25s var(--ease-out);
  }

  .chip:hover {
    border-color: var(--border-strong);
    color: var(--fg);
    transform: translateY(-1px);
  }

  .chip.ghost {
    border-style: dashed;
    background: none;
    font-family: var(--font-sans);
  }

  .pager {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-top: 4rem;
    padding-top: 2rem;
    border-top: 1px solid var(--border);
  }

  .pager a {
    display: grid;
    gap: 0.2rem;
    padding: 1rem 1.2rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-l);
    color: var(--fg);
    text-decoration: none;
    transition:
      border-color 0.25s var(--ease-out),
      box-shadow 0.3s var(--ease-out),
      transform 0.3s var(--ease-out);
  }

  .pager a:hover {
    border-color: color-mix(in oklch, var(--accent) 45%, var(--border));
    box-shadow: var(--shadow-lift);
    transform: translateY(-2px);
  }

  .dir {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .name {
    font-size: 1.02rem;
    font-weight: 560;
  }

  .next {
    grid-column: 2;
    text-align: right;
  }

  .next .dir {
    justify-content: flex-end;
  }

  .toc {
    position: sticky;
    top: calc(var(--header-h) + 2.75rem);
    align-self: start;
    max-height: calc(100dvh - var(--header-h) - 5rem);
    overflow-y: auto;
    font-size: 0.84rem;
    scrollbar-width: thin;
  }

  .toc-title {
    margin: 0 0 0.75rem;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .toc ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .toc a {
    position: relative;
    display: block;
    padding: 0.28rem 0 0.28rem 0.95rem;
    color: var(--fg-muted);
    line-height: 1.4;
    text-decoration: none;
    transition: color 0.2s var(--ease-out);
  }

  .toc a::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.3rem;
    bottom: 0.3rem;
    width: 2px;
    border-radius: 2px;
    background: var(--border);
    transition:
      background-color 0.25s var(--ease-out),
      transform 0.35s var(--ease-out);
    transform-origin: center;
    transform: scaleY(0.6);
  }

  .toc li.sub a {
    padding-left: 1.75rem;
  }

  .toc a:hover {
    color: var(--fg);
  }

  .toc a.active {
    color: var(--accent-ink);
  }

  .toc a.active::before {
    background: var(--accent);
    transform: none;
  }

  @media (max-width: 1240px) {
    .page {
      grid-template-columns: minmax(0, 1fr);
    }

    .toc {
      display: none;
    }
  }

  @media (max-width: 960px) {
    .page {
      padding: 2rem 1.25rem 4rem;
    }
  }

  @media (max-width: 560px) {
    .pager {
      grid-template-columns: 1fr;
    }

    .next {
      grid-column: 1;
    }
  }
</style>
