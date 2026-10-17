<script lang="ts">
import '../app.css';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { faBars, faXmark } from '@fortawesome/free-solid-svg-icons';
import Icon from '#lib/components/Icon.svelte';
import Logo from '#lib/components/Logo.svelte';
import Search from '#lib/components/Search.svelte';
import ThemeToggle from '#lib/components/ThemeToggle.svelte';
import { docHref } from '#lib/links.js';
import { resolve } from '$app/paths';
import { page } from '$app/state';
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();
let menuOpen = $state(false);
let sidebar = $state<HTMLElement>();
let menuButton = $state<HTMLButtonElement>();

const home = resolve('/');
const current = $derived(page.url.pathname);
const isHome = $derived(current === home);
const inGuide = $derived(current.startsWith(`${home}guide/`));
const inPackages = $derived(current.startsWith(`${home}packages/`));

// Close the mobile menu after navigating.
$effect(() => {
  void current;
  menuOpen = false;
});

$effect(() => {
  if (!menuOpen) return;
  // The drawer is modal below 960px: focus its current page link (or its first link).
  const link =
    sidebar?.querySelector<HTMLAnchorElement>('a[aria-current="page"]') ??
    sidebar?.querySelector<HTMLAnchorElement>('a');
  link?.focus({ preventScroll: true });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      menuOpen = false;
      menuButton?.focus();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
});
</script>

<a class="skip" href="#main">Skip to content</a>

<header class="header" class:flat={isHome}>
  <div class="header-inner">
    {#if !isHome}
      <button
        class="icon-button menu-button"
        type="button"
        bind:this={menuButton}
        aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
        aria-expanded={menuOpen}
        aria-controls="sidebar"
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Icon icon={menuOpen ? faXmark : faBars} size="1.05rem" />
      </button>
    {/if}
    <a class="brand" href={home} aria-label="Knead home">
      <Logo size={28} />
      <span class="wordmark">Knead</span>
    </a>
    <nav class="top-nav" aria-label="Sections">
      <a href={docHref('guide/introduction')} aria-current={inGuide ? 'true' : undefined}>Guide</a>
      <a href={docHref('packages/core')} aria-current={inPackages ? 'true' : undefined}>Packages</a>
    </nav>
    <div class="header-end">
      <Search />
      <a
        class="icon-button"
        href="https://github.com/quinnjr/knead"
        rel="noreferrer"
        aria-label="Knead on GitHub"
      >
        <Icon icon={faGithub} size="1.1rem" />
      </a>
      <ThemeToggle />
    </div>
  </div>
</header>

{#if isHome}
  <main id="main">{@render children()}</main>
{:else}
  <div class="shell">
    <nav
      id="sidebar"
      class="sidebar"
      class:open={menuOpen}
      aria-label="Documentation"
      bind:this={sidebar}
    >
      {#each data.nav as section (section.title)}
        <div class="nav-section">
          <p class="nav-title">{section.title}</p>
          <ul>
            {#each section.links as link (link.slug)}
              {@const href = docHref(link.slug)}
              <li>
                <a {href} aria-current={current === href ? 'page' : undefined}>
                  {#if link.slug.startsWith('packages/')}
                    <code>{link.slug.slice('packages/'.length)}</code>
                  {:else}
                    {link.title}
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>
    {#if menuOpen}
      <button
        class="scrim"
        type="button"
        tabindex="-1"
        aria-label="Close navigation"
        onclick={() => (menuOpen = false)}
      ></button>
    {/if}
    <main id="main" class="main" inert={menuOpen}>
      {@render children()}
    </main>
  </div>
{/if}

<style>
  .skip {
    position: fixed;
    left: 0.75rem;
    top: 0.75rem;
    z-index: 100;
    padding: 0.55rem 1rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--bg-raised);
    transform: translateY(-200%);
    transition: transform 0.25s var(--ease-out);
  }

  .skip:focus {
    transform: none;
  }

  .header {
    position: sticky;
    top: 0;
    z-index: 30;
    height: var(--header-h);
    border-bottom: 1px solid var(--border);
    background: color-mix(in oklch, var(--bg) 82%, transparent);
    backdrop-filter: saturate(1.4) blur(12px);
    -webkit-backdrop-filter: saturate(1.4) blur(12px);
  }

  .header.flat {
    border-bottom-color: transparent;
  }

  .header-inner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 100%;
    max-width: 90rem;
    margin: 0 auto;
    padding: 0 1rem 0 1.25rem;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    margin-right: 1.25rem;
    color: var(--fg);
    text-decoration: none;
  }

  .wordmark {
    font-family: var(--font-display);
    font-size: 1.55rem;
    line-height: 1;
    letter-spacing: -0.01em;
  }

  .top-nav {
    display: flex;
    gap: 0.25rem;
  }

  .top-nav a {
    position: relative;
    padding: 0.4rem 0.7rem;
    border-radius: var(--radius-s);
    color: var(--fg-soft);
    font-size: 0.9rem;
    font-weight: 500;
    text-decoration: none;
    transition:
      color 0.2s var(--ease-out),
      background-color 0.2s var(--ease-out);
  }

  .top-nav a:hover {
    background: var(--bg-sunken);
    color: var(--fg);
  }

  .top-nav a[aria-current] {
    color: var(--fg);
  }

  .top-nav a[aria-current]::after {
    content: '';
    position: absolute;
    left: 0.7rem;
    right: 0.7rem;
    bottom: -0.62rem;
    height: 2px;
    border-radius: 2px;
    background: var(--accent);
  }

  .header-end {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
  }

  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border: 0;
    border-radius: var(--radius-s);
    background: none;
    color: var(--fg-soft);
    cursor: pointer;
    transition:
      color 0.2s var(--ease-out),
      background-color 0.2s var(--ease-out),
      transform 0.15s var(--ease-out);
  }

  .icon-button:hover {
    background: var(--bg-sunken);
    color: var(--fg);
  }

  .icon-button:active {
    transform: scale(0.94);
  }

  .menu-button {
    display: none;
    margin-left: -0.5rem;
  }

  .shell {
    display: grid;
    grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
    max-width: 90rem;
    margin: 0 auto;
  }

  .sidebar {
    position: sticky;
    top: var(--header-h);
    height: calc(100dvh - var(--header-h));
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 1.75rem 1rem 4rem 1.25rem;
    border-right: 1px solid var(--border);
    font-size: 0.9rem;
    scrollbar-width: thin;
  }

  .nav-section + .nav-section {
    margin-top: 1.6rem;
  }

  .nav-title {
    margin: 0 0 0.4rem 0.7rem;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 500;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .sidebar ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .sidebar a {
    display: flex;
    align-items: center;
    min-height: 2.05rem;
    padding: 0.25rem 0.7rem;
    border-radius: var(--radius-s);
    color: var(--fg-soft);
    line-height: 1.35;
    text-decoration: none;
    transition:
      color 0.18s var(--ease-out),
      background-color 0.18s var(--ease-out),
      transform 0.25s var(--ease-out);
  }

  .sidebar a code {
    font-size: 0.84rem;
  }

  .sidebar a:hover {
    background: var(--bg-sunken);
    color: var(--fg);
    transform: translateX(2px);
  }

  .sidebar a[aria-current='page'] {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 560;
  }

  .main {
    min-width: 0;
  }

  .scrim {
    display: none;
  }

  @media (max-width: 960px) {
    .menu-button {
      display: inline-flex;
    }

    .top-nav {
      display: none;
    }

    .shell {
      display: block;
    }

    .sidebar {
      position: fixed;
      top: var(--header-h);
      bottom: 0;
      left: 0;
      z-index: 25;
      width: min(86vw, 20rem);
      height: auto;
      background: var(--bg);
      box-shadow: var(--shadow-pop);
      transform: translateX(-104%);
      visibility: hidden;
      transition:
        transform 0.35s var(--ease-out),
        visibility 0s linear 0.35s;
    }

    .sidebar.open {
      transform: none;
      visibility: visible;
      transition:
        transform 0.35s var(--ease-out),
        visibility 0s;
    }

    .sidebar a {
      min-height: 2.75rem;
    }

    .scrim {
      display: block;
      position: fixed;
      inset: var(--header-h) 0 0;
      z-index: 20;
      border: 0;
      background: oklch(0.2 0.02 50 / 0.35);
      animation: fade-in 0.3s var(--ease-out);
    }
  }

  @media (max-width: 520px) {
    .wordmark {
      display: none;
    }

    .header-inner {
      padding: 0 0.75rem;
    }
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  @media (hover: none) and (pointer: coarse) {
    .icon-button {
      width: 2.75rem;
      height: 2.75rem;
    }
  }
</style>
