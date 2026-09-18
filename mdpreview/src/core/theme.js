export const THEME_MODES = ['auto', 'light', 'dark'];

// Applies a theme mode ('auto' | 'light' | 'dark') to <html> and calls
// onChange(scheme) when the effective color scheme ('light' | 'dark') changes.
// CSS keys colors off data-theme (via color-scheme + light-dark()) and uses
// data-color-scheme for the few rules that depend on the resolved scheme.
export function createTheme(onChange) {
  const media = matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;
  let mode = 'auto';
  let scheme = null;

  const update = () => {
    const next = mode === 'auto' ? (media.matches ? 'dark' : 'light') : mode;
    root.dataset.theme = mode;
    root.dataset.colorScheme = next;
    if (next === scheme) return;
    const initial = scheme === null;
    scheme = next;
    if (!initial) onChange?.(scheme);
  };
  media.addEventListener('change', update);
  update();

  return {
    get mode() {
      return mode;
    },
    get scheme() {
      return scheme;
    },
    setMode(value) {
      mode = THEME_MODES.includes(value) ? value : 'auto';
      update();
    },
  };
}
