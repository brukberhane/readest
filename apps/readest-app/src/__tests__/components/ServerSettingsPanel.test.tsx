import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const {
  clearCustomServerConfigMock,
  createManualCustomServerConfigMock,
  loadCustomServerConfigMock,
  resolveCustomServerConfigMock,
  saveCustomServerConfigMock,
  isTauriAppPlatformMock,
} = vi.hoisted(() => ({
  clearCustomServerConfigMock: vi.fn(),
  createManualCustomServerConfigMock: vi.fn(),
  loadCustomServerConfigMock: vi.fn(),
  resolveCustomServerConfigMock: vi.fn(),
  saveCustomServerConfigMock: vi.fn(),
  isTauriAppPlatformMock: vi.fn(() => true),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: isTauriAppPlatformMock,
}));

vi.mock('@/services/customServerConfig', async () => {
  const actual = await vi.importActual<typeof import('@/services/customServerConfig')>(
    '@/services/customServerConfig',
  );
  return {
    ...actual,
    clearCustomServerConfig: clearCustomServerConfigMock,
    createManualCustomServerConfig: createManualCustomServerConfigMock,
    loadCustomServerConfig: loadCustomServerConfigMock,
    resolveCustomServerConfig: resolveCustomServerConfigMock,
    saveCustomServerConfig: saveCustomServerConfigMock,
  };
});

import ServerSettingsPanel from '@/components/settings/ServerSettingsPanel';
import { CustomServerConfigError } from '@/services/customServerConfig';

const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.signature';

const resolvedConfig = {
  serverBaseUrl: 'https://readest.example.com',
  apiBaseUrl: 'https://readest.example.com',
  supabaseUrl: 'https://supabase.example.com',
  supabaseAnonKey: anonKey,
  fetchedAt: 123,
};

beforeEach(() => {
  isTauriAppPlatformMock.mockReset();
  isTauriAppPlatformMock.mockReturnValue(true);
  clearCustomServerConfigMock.mockReset();
  clearCustomServerConfigMock.mockResolvedValue(undefined);
  createManualCustomServerConfigMock.mockReset();
  createManualCustomServerConfigMock.mockResolvedValue(resolvedConfig);
  loadCustomServerConfigMock.mockReset();
  loadCustomServerConfigMock.mockReturnValue(null);
  resolveCustomServerConfigMock.mockReset();
  saveCustomServerConfigMock.mockReset();
  saveCustomServerConfigMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

const enterServerUrl = () => {
  fireEvent.change(screen.getByPlaceholderText('https://readest.example.com'), {
    target: { value: 'https://readest.example.com/' },
  });
};

const openCompatibilityMode = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Official Docker compatibility' }));
};

describe('ServerSettingsPanel official Docker compatibility', () => {
  test('does not expose custom-server controls in a web build', () => {
    isTauriAppPlatformMock.mockReturnValue(false);

    render(<ServerSettingsPanel />);

    expect(screen.queryByLabelText('Server URL')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Official Docker compatibility' })).toBeNull();
  });

  test('expands and safely prefills compatibility fields when discovery is unavailable', async () => {
    resolveCustomServerConfigMock.mockRejectedValue(
      new CustomServerConfigError(
        'manual-config-required',
        'Public client config is not discoverable.',
        {
          apiBaseUrl: 'https://readest.example.com',
          supabaseUrl: 'https://supabase.example.com',
        },
      ),
    );
    render(<ServerSettingsPanel />);
    enterServerUrl();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(screen.getByLabelText('API base URL')).toBeTruthy());
    expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe(
      'https://readest.example.com',
    );
    expect((screen.getByLabelText('Supabase public URL') as HTMLInputElement).value).toBe(
      'https://supabase.example.com',
    );
    expect(
      (screen.getByLabelText('Supabase anon or publishable key') as HTMLInputElement).type,
    ).toBe('password');
    expect(
      screen.getAllByText(
        'Public client config was not found. Enter the official Docker public settings below.',
      ).length,
    ).toBeGreaterThan(0);
  });

  test('allows compatibility mode to be opened explicitly', () => {
    render(<ServerSettingsPanel />);

    openCompatibilityMode();

    expect(screen.getByLabelText('API base URL')).toBeTruthy();
    expect(screen.getByLabelText('Supabase public URL')).toBeTruthy();
    expect(screen.getByLabelText('Supabase anon or publishable key')).toBeTruthy();
  });

  test('validates and saves all manual compatibility values', async () => {
    render(<ServerSettingsPanel />);
    enterServerUrl();
    openCompatibilityMode();
    fireEvent.change(screen.getByLabelText('API base URL'), {
      target: { value: 'https://api.example.com/' },
    });
    fireEvent.change(screen.getByLabelText('Supabase public URL'), {
      target: { value: 'https://supabase.example.com/' },
    });
    fireEvent.change(screen.getByLabelText('Supabase anon or publishable key'), {
      target: { value: anonKey },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(createManualCustomServerConfigMock).toHaveBeenCalledWith(
        {
          serverBaseUrl: 'https://readest.example.com/',
          apiBaseUrl: 'https://api.example.com/',
          supabaseUrl: 'https://supabase.example.com/',
          supabaseAnonKey: anonKey,
        },
        { allowInsecureHttp: false },
      ),
    );
    expect(saveCustomServerConfigMock).toHaveBeenCalledWith(resolvedConfig, {
      resetSession: true,
    });
  });

  test('tests the entered manual values without saving them', async () => {
    render(<ServerSettingsPanel />);
    enterServerUrl();
    openCompatibilityMode();
    fireEvent.change(screen.getByLabelText('Supabase public URL'), {
      target: { value: 'https://supabase.example.com/' },
    });
    fireEvent.change(screen.getByLabelText('Supabase anon or publishable key'), {
      target: { value: anonKey },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(createManualCustomServerConfigMock).toHaveBeenCalled());
    expect(resolveCustomServerConfigMock).not.toHaveBeenCalled();
    expect(saveCustomServerConfigMock).not.toHaveBeenCalled();
  });

  test('preserves every manual value after validation fails', async () => {
    createManualCustomServerConfigMock.mockRejectedValue(
      new CustomServerConfigError('api-unreachable', 'Readest API probe failed.'),
    );
    render(<ServerSettingsPanel />);
    enterServerUrl();
    openCompatibilityMode();
    fireEvent.change(screen.getByLabelText('API base URL'), {
      target: { value: 'https://api.example.com/' },
    });
    fireEvent.change(screen.getByLabelText('Supabase public URL'), {
      target: { value: 'https://supabase.example.com/' },
    });
    fireEvent.change(screen.getByLabelText('Supabase anon or publishable key'), {
      target: { value: anonKey },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getAllByText('Readest API is not reachable').length).toBeGreaterThan(0),
    );
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).value).toBe(
      'https://readest.example.com/',
    );
    expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe(
      'https://api.example.com/',
    );
    expect((screen.getByLabelText('Supabase public URL') as HTMLInputElement).value).toBe(
      'https://supabase.example.com/',
    );
    expect(
      (screen.getByLabelText('Supabase anon or publishable key') as HTMLInputElement).value,
    ).toBe(anonKey);
  });

  test('reset clears and collapses compatibility mode', async () => {
    render(<ServerSettingsPanel />);
    enterServerUrl();
    openCompatibilityMode();

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));

    await waitFor(() => expect(clearCustomServerConfigMock).toHaveBeenCalled());
    expect(screen.queryByLabelText('API base URL')).toBeNull();
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).value).toBe('');
  });
});
