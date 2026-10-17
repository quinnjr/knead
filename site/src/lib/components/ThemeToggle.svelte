<script lang="ts">
import { faMoon, faSun } from '@fortawesome/free-regular-svg-icons';
import Icon from './Icon.svelte';

type Theme = 'light' | 'dark';

let theme = $state<Theme>('light');

$effect(() => {
  const saved = document.documentElement.dataset.theme;
  const media = matchMedia('(prefers-color-scheme: dark)');
  const sync = () => {
    const current = document.documentElement.dataset.theme;
    theme = current === 'light' || current === 'dark' ? current : media.matches ? 'dark' : 'light';
  };
  theme = saved === 'light' || saved === 'dark' ? saved : media.matches ? 'dark' : 'light';
  media.addEventListener('change', sync);
  return () => media.removeEventListener('change', sync);
});

function toggle() {
  theme = theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('knead-theme', theme);
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this page only.
  }
}
</script>

<button
  class="toggle"
  type="button"
  onclick={toggle}
  aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
>
  {#key theme}
    <span class="glyph">
      <Icon icon={theme === 'dark' ? faSun : faMoon} size="1.05rem" />
    </span>
  {/key}
</button>

<style>
  .toggle {
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

  .toggle:hover {
    background: var(--bg-sunken);
    color: var(--fg);
  }

  .toggle:active {
    transform: scale(0.94);
  }

  .glyph {
    display: inline-flex;
    animation: turn 0.45s var(--ease-out);
  }

  @keyframes turn {
    from {
      opacity: 0;
      transform: rotate(-60deg) scale(0.7);
    }
  }

  @media (hover: none) and (pointer: coarse) {
    .toggle {
      width: 2.75rem;
      height: 2.75rem;
    }
  }
</style>
