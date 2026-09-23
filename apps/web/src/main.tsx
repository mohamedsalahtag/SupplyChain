import { StrictMode, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, TRPCClientError } from '@trpc/client';
import { App as AntApp, ConfigProvider, theme, type ThemeConfig } from 'antd';
import type { MappingAlgorithm } from 'antd/es/theme/interface';
import { trpc } from './lib/trpc';
import { AppLayout } from './AppLayout';
import { LoginPage } from './pages/LoginPage';

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
  const [queryClient] = useState(() => {
    const code = (err: unknown) => (err instanceof TRPCClientError ? (err.data as { code?: string } | undefined)?.code : undefined);
    // Session ended (expired, or user disabled): refresh who is signed in, which sends the app to the login page.
    const onError = (err: unknown) => {
      if (code(err) === 'UNAUTHORIZED') void client.invalidateQueries({ queryKey: [['auth', 'me']] });
    };
    const client: QueryClient = new QueryClient({
      queryCache: new QueryCache({ onError }),
      mutationCache: new MutationCache({ onError }),
      defaultOptions: {
        // One retry only, so a real error reaches the screen quickly; never retry sign-in or permission refusals.
        queries: { retry: (n, err) => n < 1 && !['UNAUTHORIZED', 'FORBIDDEN'].includes(code(err) ?? '') },
      },
    });
    return client;
  });
  const [trpcClient] = useState(() => trpc.createClient({ links: [httpBatchLink({ url: '/trpc' })] }));

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Themed>
          <AntApp>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/*" element={<AppLayout />} />
              </Routes>
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
