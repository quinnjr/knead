<script lang="ts">
let { size = 28 }: { size?: number } = $props();
</script>

<!-- A folded "K": two dough strokes pressed into a rounded tile. -->
<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <rect width="32" height="32" rx="9" fill="var(--accent)" />
  <path
    d="M10.5 8.5v15M21.5 8.5 13 16.2c-.6.5-.6 1.3 0 1.8l8.5 5.5"
    fill="none"
    stroke="var(--accent-contrast)"
    stroke-width="3.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
