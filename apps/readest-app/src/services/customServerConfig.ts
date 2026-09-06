import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { jwtDecode } from 'jwt-decode';

export interface PublicReadestClientConfig {
  apiBaseUrl?: string | undefined;
  supabaseUrl?: string | undefined;
  supabaseAnonKey?: string | undefined;
  objectStorageType?: string | undefined;
  storageFixedQuota?: number | undefined;
  translationFixedQuota?: number | undefined;
  selfHosted?: boolean | undefined;
}

export interface CustomServerConfig {
  serverBaseUrl: string;
  apiBaseUrl: string;
  supabaseUrl?: string | undefined;
  supabaseAnonKey?: string | undefined;
  selfHosted?: boolean | undefined;
  fetchedAt: number;
}

export interface ManualCustomServerConfigInput {
  serverBaseUrl: string;
  apiBaseUrl?: string | undefined;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

interface StorageAdapter {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export type CustomServerConfigErrorCode =
  | 'invalid-url'
  | 'insecure-http'
  | 'server-not-reachable'
  | 'invalid-config'
  | 'missing-supabase-config'
  | 'dangerous-secret'
  | 'manual-config-required'
  | 'request-timeout'
  | 'tls-error'
  | 'api-unreachable'
  | 'supabase-unreachable';

export class CustomServerConfigError extends Error {
  code: CustomServerConfigErrorCode;
  suggestedConfig?: PublicReadestClientConfig | undefined;

  constructor(
    code: CustomServerConfigErrorCode,
    message: string,
    suggestedConfig?: PublicReadestClientConfig,
  ) {
    super(message);
    this.name = 'CustomServerConfigError';
    this.code = code;
    this.suggestedConfig = suggestedConfig;
  }
}

interface NormalizeUrlOptions {
  allowInsecureHttp?: boolean;
}

interface ResolveCustomServerConfigOptions extends NormalizeUrlOptions {
  fetchImpl?: typeof fetch;
  requireSupabase?: boolean;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface SaveCustomServerConfigOptions {
  resetSession?: boolean;
}

const CUSTOM_SERVER_CONFIG_KEY = 'readest_custom_server_config_v1';

const PUBLIC_CONFIG_SOURCES = [
  { path: '/.well-known/readest-client-config.json', format: 'json' },
  { path: '/api/public/runtime-config', format: 'json' },
  { path: '/runtime-config.js', format: 'script' },
] as const;

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

const DANGEROUS_SECRET_FIELDS = [
  'service_role',
  'jwt_secret',
  'postgres_password',
  'database_url',
  's3_secret',
  'aws_secret_access_key',
  'private_key',
] as const;

let storageAdapter: StorageAdapter | null = null;

const getStorageAdapter = (): StorageAdapter | null => {
  if (storageAdapter) return storageAdapter;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
};

export const setCustomServerConfigStorageAdapter = (adapter: StorageAdapter | null) => {
  storageAdapter = adapter;
};

const isDevelopmentBuild = () => process.env['NODE_ENV'] === 'development';
const isTauriClientBuild = () => process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri';

const normalizeHostname = (hostname: string) => hostname.toLowerCase().replace(/^\[|\]$/g, '');

const isPrivateIpv4 = (hostname: string) => {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;

  const first = octets[0]!;
  const second = octets[1]!;
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
};

const isLocalOrPrivateHost = (hostname: string) => {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.endsWith('.local') ||
    isPrivateIpv4(normalized)
  );
};

export const normalizeServerBaseUrl = (
  input: string,
  { allowInsecureHttp = isDevelopmentBuild() }: NormalizeUrlOptions = {},
) => {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new CustomServerConfigError('invalid-url', 'Server URL is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CustomServerConfigError('invalid-url', 'Server URL must be a valid URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CustomServerConfigError('invalid-url', 'Server URL must use http or https.');
  }

  if (parsed.username || parsed.password) {
    throw new CustomServerConfigError('invalid-url', 'Server URL must not include credentials.');
  }

  if (
    parsed.protocol === 'http:' &&
    !(allowInsecureHttp && isLocalOrPrivateHost(parsed.hostname))
  ) {
    throw new CustomServerConfigError(
      'insecure-http',
      'Insecure http is only allowed for local development servers.',
    );
  }

  parsed.hash = '';
  parsed.search = '';

  return parsed.toString().replace(/\/+$/, '');
};

const normalizeConfigUrl = (input: string, options: NormalizeUrlOptions) =>
  normalizeServerBaseUrl(input, options);

const joinUrlPath = (baseUrl: string, path: string) => {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${path}`;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeSecretField = (field: string) => field.toLowerCase().replace(/[-\s]/g, '_');

const findDangerousSecretField = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDangerousSecretField(item);
      if (found) return found;
    }
    return null;
  }

  if (!isPlainObject(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeSecretField(key);
    const dangerousField = DANGEROUS_SECRET_FIELDS.find((field) => normalizedKey.includes(field));
    if (dangerousField) return key;

    const found = findDangerousSecretField(child);
    if (found) return found;
  }

  return null;
};

const assertNoDangerousSecrets = (config: unknown) => {
  const field = findDangerousSecretField(config);
  if (field) {
    throw new CustomServerConfigError(
      'dangerous-secret',
      `Server config exposes a dangerous secret field: ${field}.`,
    );
  }
};

const validateSupabasePublicKey = (key: string) => {
  if (key.startsWith('sb_secret_')) {
    throw new CustomServerConfigError(
      'dangerous-secret',
      'Supabase server secret keys must not be used in the client.',
    );
  }

  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return;

  try {
    const payload = jwtDecode<{ role?: unknown }>(key);
    if (payload.role === 'service_role') {
      throw new CustomServerConfigError(
        'dangerous-secret',
        'Supabase service-role keys must not be used in the client.',
      );
    }
    if (payload.role === 'anon') return;
  } catch (error) {
    if (error instanceof CustomServerConfigError) throw error;
  }

  throw new CustomServerConfigError(
    'invalid-config',
    'Supabase public key must be an anon JWT or publishable key.',
  );
};

const validatePublicConfig = (
  serverBaseUrl: string,
  config: unknown,
  {
    allowInsecureHttp = isDevelopmentBuild(),
    requireSupabase = true,
  }: NormalizeUrlOptions & { requireSupabase?: boolean } = {},
): PublicReadestClientConfig => {
  assertNoDangerousSecrets(config);

  if (!isPlainObject(config)) {
    throw new CustomServerConfigError('invalid-config', 'Server config must be a JSON object.');
  }

  const apiBaseUrlValue = config['apiBaseUrl'];
  const supabaseUrlValue = config['supabaseUrl'];
  const supabaseAnonKeyValue = config['supabaseAnonKey'];
  const selfHostedValue = config['selfHosted'];

  const apiBaseUrl =
    typeof apiBaseUrlValue === 'string' && apiBaseUrlValue.trim()
      ? normalizeConfigUrl(apiBaseUrlValue, { allowInsecureHttp })
      : serverBaseUrl;

  const supabaseUrl =
    typeof supabaseUrlValue === 'string' && supabaseUrlValue.trim()
      ? normalizeConfigUrl(supabaseUrlValue, { allowInsecureHttp })
      : undefined;
  const supabaseAnonKey =
    typeof supabaseAnonKeyValue === 'string' && supabaseAnonKeyValue.trim()
      ? supabaseAnonKeyValue.trim()
      : undefined;
  const selfHosted = typeof selfHostedValue === 'boolean' ? selfHostedValue : undefined;

  if (supabaseAnonKey) validateSupabasePublicKey(supabaseAnonKey);

  if (requireSupabase && (!supabaseUrl || !supabaseAnonKey)) {
    throw new CustomServerConfigError(
      'missing-supabase-config',
      'Server config must include supabaseUrl and supabaseAnonKey.',
    );
  }

  return {
    apiBaseUrl,
    supabaseUrl,
    supabaseAnonKey,
    selfHosted,
  };
};

export const getCustomServerFetch = (fetchImpl?: typeof fetch): typeof fetch => {
  if (fetchImpl) return fetchImpl;
  if (isTauriClientBuild()) return tauriFetch as unknown as typeof fetch;
  if (!globalThis.fetch) {
    throw new CustomServerConfigError('server-not-reachable', 'Fetch API is not available.');
  }
  return globalThis.fetch.bind(globalThis);
};

export const parseRuntimeConfigScript = (source: string): unknown => {
  const match = source.match(/^\s*window\.__READEST_RUNTIME_CONFIG\s*=\s*(\{[\s\S]*\})\s*;\s*$/);
  if (!match?.[1]) {
    throw new CustomServerConfigError(
      'invalid-config',
      'Runtime config script has an invalid envelope.',
    );
  }

  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    throw new CustomServerConfigError(
      'invalid-config',
      'Runtime config script contains invalid JSON.',
    );
  }
};

const fetchConfigSource = async (
  url: string,
  format: (typeof PUBLIC_CONFIG_SOURCES)[number]['format'],
  fetchImpl: typeof fetch,
  options: ResolveCustomServerConfigOptions,
) => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: format === 'json' ? 'application/json' : 'application/javascript, text/javascript',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new CustomServerConfigError(
        'server-not-reachable',
        `Server config endpoint returned HTTP ${response.status}.`,
      );
    }

    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      throw new CustomServerConfigError('invalid-config', 'Server config response is too large.');
    }

    const source = await response.text();
    if (new TextEncoder().encode(source).byteLength > maxResponseBytes) {
      throw new CustomServerConfigError('invalid-config', 'Server config response is too large.');
    }

    if (format === 'script') return parseRuntimeConfigScript(source);
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new CustomServerConfigError(
        'invalid-config',
        'Server config response is not valid JSON.',
      );
    }
  } catch (error) {
    if (error instanceof CustomServerConfigError) throw error;
    if (controller.signal.aborted) {
      throw new CustomServerConfigError('request-timeout', 'Server config request timed out.');
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/certificate|\btls\b|\bssl\b/i.test(message)) {
      throw new CustomServerConfigError('tls-error', 'Server config TLS connection failed.');
    }
    throw new CustomServerConfigError('server-not-reachable', 'Server config request failed.');
  } finally {
    clearTimeout(timeout);
  }
};

const mergeSuggestedConfig = (
  previous: PublicReadestClientConfig,
  next: PublicReadestClientConfig,
): PublicReadestClientConfig => ({
  apiBaseUrl: next.apiBaseUrl ?? previous.apiBaseUrl,
  supabaseUrl: next.supabaseUrl ?? previous.supabaseUrl,
  supabaseAnonKey: next.supabaseAnonKey ?? previous.supabaseAnonKey,
  selfHosted: next.selfHosted ?? previous.selfHosted,
});

export const fetchPublicClientConfig = async (
  serverBaseUrlInput: string,
  options: ResolveCustomServerConfigOptions = {},
) => {
  const serverBaseUrl = normalizeServerBaseUrl(serverBaseUrlInput, options);
  const fetchImpl = getCustomServerFetch(options.fetchImpl);

  let suggestedConfig: PublicReadestClientConfig = {};
  let hasSuggestedConfig = false;
  for (const source of PUBLIC_CONFIG_SOURCES) {
    try {
      const config = await fetchConfigSource(
        joinUrlPath(serverBaseUrl, source.path),
        source.format,
        fetchImpl,
        options,
      );
      const partialConfig = validatePublicConfig(serverBaseUrl, config, {
        ...options,
        requireSupabase: false,
      });
      suggestedConfig = mergeSuggestedConfig(suggestedConfig, partialConfig);
      hasSuggestedConfig = true;
      if (options.requireSupabase === false) return partialConfig;
      return validatePublicConfig(serverBaseUrl, config, options);
    } catch (error) {
      if (error instanceof CustomServerConfigError && error.code === 'dangerous-secret') {
        throw error;
      }
    }
  }

  throw new CustomServerConfigError(
    'manual-config-required',
    'Public client config is not discoverable.',
    hasSuggestedConfig ? suggestedConfig : undefined,
  );
};

export const resolveCustomServerConfig = async (
  serverBaseUrlInput: string,
  options: ResolveCustomServerConfigOptions = {},
): Promise<CustomServerConfig> => {
  const serverBaseUrl = normalizeServerBaseUrl(serverBaseUrlInput, options);
  const publicConfig = await fetchPublicClientConfig(serverBaseUrl, options);

  return {
    serverBaseUrl,
    apiBaseUrl: publicConfig.apiBaseUrl ?? serverBaseUrl,
    supabaseUrl: publicConfig.supabaseUrl,
    supabaseAnonKey: publicConfig.supabaseAnonKey,
    selfHosted: publicConfig.selfHosted,
    fetchedAt: options.now?.() ?? Date.now(),
  };
};

const fetchConnectivityProbe = async (
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  options: ResolveCustomServerConfigOptions,
  unreachableCode: 'api-unreachable' | 'supabase-unreachable',
) => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new CustomServerConfigError('request-timeout', 'Connection request timed out.');
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/certificate|\btls\b|\bssl\b/i.test(message)) {
      throw new CustomServerConfigError('tls-error', 'TLS connection failed.');
    }
    throw new CustomServerConfigError(unreachableCode, 'Connection request failed.');
  } finally {
    clearTimeout(timeout);
  }
};

export const validateCustomServerConnectivity = async (
  config: CustomServerConfig,
  options: ResolveCustomServerConfigOptions = {},
) => {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new CustomServerConfigError(
      'missing-supabase-config',
      'Supabase URL and public key are required.',
    );
  }

  const fetchImpl = getCustomServerFetch(options.fetchImpl);
  const apiResponse = await fetchConnectivityProbe(
    joinUrlPath(config.apiBaseUrl, '/api/sync'),
    { method: 'GET', headers: { Accept: 'application/json' } },
    fetchImpl,
    options,
    'api-unreachable',
  );
  if (!apiResponse.ok && apiResponse.status !== 401 && apiResponse.status !== 403) {
    throw new CustomServerConfigError(
      'api-unreachable',
      `Readest API probe returned HTTP ${apiResponse.status}.`,
    );
  }

  const supabaseResponse = await fetchConnectivityProbe(
    joinUrlPath(config.supabaseUrl, '/auth/v1/settings'),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
      },
    },
    fetchImpl,
    options,
    'supabase-unreachable',
  );
  if (!supabaseResponse.ok) {
    throw new CustomServerConfigError(
      'supabase-unreachable',
      `Supabase probe returned HTTP ${supabaseResponse.status}.`,
    );
  }
};

export const createManualCustomServerConfig = async (
  input: ManualCustomServerConfigInput,
  options: ResolveCustomServerConfigOptions = {},
): Promise<CustomServerConfig> => {
  const serverBaseUrl = normalizeServerBaseUrl(input.serverBaseUrl, options);
  const publicConfig = validatePublicConfig(
    serverBaseUrl,
    {
      apiBaseUrl: input.apiBaseUrl?.trim() || serverBaseUrl,
      supabaseUrl: input.supabaseUrl,
      supabaseAnonKey: input.supabaseAnonKey,
    },
    options,
  );
  const config: CustomServerConfig = {
    serverBaseUrl,
    apiBaseUrl: publicConfig.apiBaseUrl ?? serverBaseUrl,
    supabaseUrl: publicConfig.supabaseUrl,
    supabaseAnonKey: publicConfig.supabaseAnonKey,
    selfHosted: publicConfig.selfHosted,
    fetchedAt: options.now?.() ?? Date.now(),
  };

  await validateCustomServerConnectivity(config, options);
  return config;
};

const hasSameEffectiveServerConfig = (
  previous: CustomServerConfig | null,
  next: CustomServerConfig,
) =>
  previous !== null &&
  previous.serverBaseUrl === next.serverBaseUrl &&
  previous.apiBaseUrl === next.apiBaseUrl &&
  (previous.supabaseUrl ?? '') === (next.supabaseUrl ?? '') &&
  (previous.supabaseAnonKey ?? '') === (next.supabaseAnonKey ?? '');

export const saveCustomServerConfig = async (
  config: CustomServerConfig,
  { resetSession = false }: SaveCustomServerConfigOptions = {},
) => {
  const storage = getStorageAdapter();
  const previous = loadCustomServerConfig();
  storage?.setItem(CUSTOM_SERVER_CONFIG_KEY, JSON.stringify(config));

  if (resetSession && !hasSameEffectiveServerConfig(previous, config)) {
    const { clearAuthSessionForServerChange } = await import('@/helpers/auth');
    await clearAuthSessionForServerChange();
  }
};

export const loadCustomServerConfig = (): CustomServerConfig | null => {
  const storage = getStorageAdapter();
  if (!storage) return null;

  const raw = storage.getItem(CUSTOM_SERVER_CONFIG_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return null;
    const serverBaseUrl = parsed['serverBaseUrl'];
    const apiBaseUrl = parsed['apiBaseUrl'];
    const fetchedAt = parsed['fetchedAt'];
    if (
      typeof serverBaseUrl !== 'string' ||
      typeof apiBaseUrl !== 'string' ||
      typeof fetchedAt !== 'number'
    ) {
      return null;
    }

    return {
      serverBaseUrl,
      apiBaseUrl,
      supabaseUrl:
        typeof parsed['supabaseUrl'] === 'string' ? (parsed['supabaseUrl'] as string) : undefined,
      supabaseAnonKey:
        typeof parsed['supabaseAnonKey'] === 'string'
          ? (parsed['supabaseAnonKey'] as string)
          : undefined,
      selfHosted:
        typeof parsed['selfHosted'] === 'boolean' ? (parsed['selfHosted'] as boolean) : undefined,
      fetchedAt,
    };
  } catch {
    return null;
  }
};

export const clearCustomServerConfig = async ({
  resetSession = false,
}: SaveCustomServerConfigOptions = {}) => {
  const previous = loadCustomServerConfig();
  const storage = getStorageAdapter();
  storage?.removeItem(CUSTOM_SERVER_CONFIG_KEY);

  if (resetSession && previous) {
    const { clearAuthSessionForServerChange } = await import('@/helpers/auth');
    await clearAuthSessionForServerChange();
  }
};

export const getCustomServerRuntimeConfig = (): PublicReadestClientConfig | null => {
  const config = loadCustomServerConfig();
  if (!config) return null;
  return {
    apiBaseUrl: config.apiBaseUrl,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    selfHosted: config.selfHosted,
  };
};

export const getCustomServerConfigStorageKey = () => CUSTOM_SERVER_CONFIG_KEY;
