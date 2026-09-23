import { StrictMode, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { App as AntApp, ConfigProvider, theme, type ThemeConfig } from 'antd';
import type { MappingAlgorithm } from 'antd/es/theme/interface';
import { trpc } from './lib/trpc';
import { AppLayout } from './AppLayout';

/** Used until the saved appearance loads (and if it cannot). */
const DEFAULT_FONT_SIZE = 13;
const DEFAULT_ICON = '/favicon.svg';

/**
 * antd's compact algorithm also shrinks text (it uses fontSizeSM as the base),
 * so a chosen 12px rendered as 10px. Keep compact spacing but restore the font
 * tokens from the default algorithm, so the chosen size is the size on screen.
 */
const keepChosenFontSize: MappingAlgorithm = (seed, map) => {
  const plain = theme.defaultAlgorithm(seed);
  const fontTokens = Object.fromEntries(
    Object.entries(plain).filter(([k]) => k.startsWith('fontSize') || k.startsWith('lineHeight') || k.startsWith('fontHeight')),
  );
  return { ...(map ?? plain), ...fontTokens };
};

/** Compact, dense look: screens will carry many details, so tight rows. */
const buildTheme = (fontSize: number): ThemeConfig => ({
  algorithm: [theme.compactAlgorithm, keepChosenFontSize],
  token: { colorPrimary: '#1f6f43', borderRadius: 4, fontSize, lineHeight: 1.4 },
  components: {
    Table: { cellPaddingBlockSM: 3, cellPaddingInlineSM: 6 },
    Menu: { itemHeight: Math.round(fontSize * 2.4), subMenuItemBg: 'transparent' },
  },
});

/** Applies the app-wide font size, site name and icon from Configuration. */
function Themed({ children }: { children: ReactNode }) {
  const ui = trpc.settings.getUi.useQuery(undefined, { staleTime: Infinity });
  const fontSize = ui.data?.fontSize ?? DEFAULT_FONT_SIZE;
  const themeConfig = useMemo(() => buildTheme(fontSize), [fontSize]);

  useEffect(() => {
    if (!ui.data) return;
    document.title = ui.data.siteName;
    const link = document.getElementById('app-icon') as HTMLLinkElement | null;
    if (link) link.href = ui.data.iconDataUrl ?? DEFAULT_ICON;
  }, [ui.data]);

  return (
    <ConfigProvider componentSize="small" theme={themeConfig}>
      {children}
    </ConfigProvider>
  );
}

function Root() {
  // One retry only, so a real error reaches the screen quickly instead of after ~7 s of retries.
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  const [trpcClient] = useState(() => trpc.createClient({ links: [httpBatchLink({ url: '/trpc' })] }));

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Themed>
          <AntApp>
            <BrowserRouter>
              <AppLayout />
            </BrowserRouter>
          </AntApp>
        </Themed>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
