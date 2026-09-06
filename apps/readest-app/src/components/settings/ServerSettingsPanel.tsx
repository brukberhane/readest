'use client';

import clsx from 'clsx';
import React, { useEffect, useMemo, useState } from 'react';
import { MdCheckCircle, MdRefresh, MdSave, MdSettingsEthernet } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import {
  clearCustomServerConfig,
  createManualCustomServerConfig,
  CustomServerConfigError,
  loadCustomServerConfig,
  normalizeServerBaseUrl,
  resolveCustomServerConfig,
  saveCustomServerConfig,
} from '@/services/customServerConfig';
import type { CustomServerConfig } from '@/services/customServerConfig';
import { isTauriAppPlatform } from '@/services/environment';
import { BoxedList, SettingsRow } from './primitives';

type TestState =
  | { status: 'idle'; message?: string }
  | { status: 'success'; message: string; config: CustomServerConfig }
  | { status: 'error'; message: string };

interface ServerSettingsPanelProps {
  compact?: boolean;
}

const maskAnonKey = (key: string | undefined, translate: (key: string) => string) => {
  if (!key) return translate('Not provided');
  if (key.length <= 10) return translate('Hidden');
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
};

const getHost = (url: string | undefined, translate: (key: string) => string) => {
  if (!url) return translate('Not provided');
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const getErrorMessage = (error: unknown, translate: (key: string) => string) => {
  if (error instanceof CustomServerConfigError) {
    switch (error.code) {
      case 'server-not-reachable':
        return translate('Server not reachable');
      case 'manual-config-required':
        return translate(
          'Public client config was not found. Enter the official Docker public settings below.',
        );
      case 'request-timeout':
        return translate('Request timed out');
      case 'tls-error':
        return translate('TLS connection failed');
      case 'api-unreachable':
        return translate('Readest API is not reachable');
      case 'supabase-unreachable':
        return translate('Supabase is not reachable');
      case 'invalid-config':
        return translate('Invalid public client config');
      case 'missing-supabase-config':
        return translate('Missing Supabase config');
      case 'insecure-http':
        return translate('Insecure http not allowed');
      case 'dangerous-secret':
        return translate('Dangerous secret exposed by server config');
      case 'invalid-url':
      default:
        return translate('Invalid server URL');
    }
  }
  return translate('Server not reachable');
};

const ServerSettingsPanel: React.FC<ServerSettingsPanelProps> = ({ compact = false }) => {
  const _ = useTranslation();
  const isTauriPlatform = isTauriAppPlatform();
  const [serverUrl, setServerUrl] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseAnonKey, setSupabaseAnonKey] = useState('');
  const [compatibilityExpanded, setCompatibilityExpanded] = useState(false);
  const [savedConfig, setSavedConfig] = useState<CustomServerConfig | null>(null);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    if (!isTauriPlatform) return;
    const config = loadCustomServerConfig();
    setSavedConfig(config);
    setServerUrl(config?.serverBaseUrl ?? '');
    setApiBaseUrl(config?.apiBaseUrl ?? '');
    setSupabaseUrl(config?.supabaseUrl ?? '');
    setSupabaseAnonKey(config?.supabaseAnonKey ?? '');
  }, [isTauriPlatform]);

  const effectiveConfig = useMemo(() => {
    if (testState.status === 'success') return testState.config;
    return savedConfig;
  }, [savedConfig, testState]);

  const allowInsecureHttp = process.env.NODE_ENV === 'development';

  const handleTestConnection = async () => {
    setIsTesting(true);
    try {
      const config = compatibilityExpanded
        ? await createManualCustomServerConfig(
            {
              serverBaseUrl: serverUrl,
              apiBaseUrl,
              supabaseUrl,
              supabaseAnonKey,
            },
            { allowInsecureHttp },
          )
        : await resolveCustomServerConfig(serverUrl, { allowInsecureHttp });
      setTestState({
        status: 'success',
        message: _('Connection successful'),
        config,
      });
    } catch (error) {
      if (error instanceof CustomServerConfigError && error.code === 'manual-config-required') {
        try {
          const normalizedServerUrl = normalizeServerBaseUrl(serverUrl, { allowInsecureHttp });
          setServerUrl(normalizedServerUrl);
          setApiBaseUrl(
            (value) => value || error.suggestedConfig?.apiBaseUrl || normalizedServerUrl,
          );
          setSupabaseUrl((value) => value || error.suggestedConfig?.supabaseUrl || '');
          setSupabaseAnonKey((value) => value || error.suggestedConfig?.supabaseAnonKey || '');
        } catch {
          // The original discovery error remains the user-facing result.
        }
        setCompatibilityExpanded(true);
      }
      setTestState({ status: 'error', message: getErrorMessage(error, _) });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      let config: CustomServerConfig;
      if (compatibilityExpanded) {
        config = await createManualCustomServerConfig(
          {
            serverBaseUrl: serverUrl,
            apiBaseUrl,
            supabaseUrl,
            supabaseAnonKey,
          },
          { allowInsecureHttp },
        );
      } else {
        const normalizedInput = normalizeServerBaseUrl(serverUrl, { allowInsecureHttp });
        config =
          testState.status === 'success' && testState.config.serverBaseUrl === normalizedInput
            ? testState.config
            : await resolveCustomServerConfig(serverUrl, { allowInsecureHttp });
      }
      await saveCustomServerConfig(config, { resetSession: true });
      setSavedConfig(config);
      setServerUrl(config.serverBaseUrl);
      setApiBaseUrl(config.apiBaseUrl);
      setSupabaseUrl(config.supabaseUrl ?? '');
      setSupabaseAnonKey(config.supabaseAnonKey ?? '');
      setCompatibilityExpanded(false);
      setTestState({
        status: 'success',
        message: _('Server saved. Please sign in again.'),
        config,
      });
    } catch (error) {
      setTestState({ status: 'error', message: getErrorMessage(error, _) });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsResetting(true);
    try {
      await clearCustomServerConfig({ resetSession: true });
      setSavedConfig(null);
      setServerUrl('');
      setApiBaseUrl('');
      setSupabaseUrl('');
      setSupabaseAnonKey('');
      setCompatibilityExpanded(false);
      setTestState({ status: 'idle', message: _('Server settings reset. Please sign in again.') });
    } finally {
      setIsResetting(false);
    }
  };

  const statusText =
    testState.message ?? (savedConfig ? _('Custom server enabled') : _('Default server'));

  if (!isTauriPlatform) {
    return (
      <div className={clsx(compact ? 'w-full' : 'my-4 w-full space-y-6')}>
        <BoxedList
          title={_('Server Settings')}
          description={_('Custom servers are available in the desktop and mobile app.')}
          data-setting-id='settings.server'
        >
          <SettingsRow
            label={_('Custom server')}
            description={_('Open Readest on a desktop or mobile device to change servers.')}
          />
        </BoxedList>
      </div>
    );
  }

  return (
    <div className={clsx(compact ? 'w-full' : 'my-4 w-full space-y-6')}>
      <BoxedList
        title={_('Server Settings')}
        description={_('Changing servers signs you out so sessions cannot cross servers.')}
        data-setting-id='settings.server'
      >
        <SettingsRow
          label={_('Server URL')}
          description={statusText}
          align='start'
          data-setting-id='settings.server.url'
        >
          <div className='flex w-full max-w-full flex-col items-end gap-2 sm:max-w-[60%]'>
            <input
              aria-label={_('Server URL')}
              className='input settings-content input-bordered eink-bordered h-9 w-full rounded-md text-end'
              value={serverUrl}
              placeholder='https://readest.example.com'
              onChange={(event) => {
                setServerUrl(event.target.value);
                setTestState({ status: 'idle' });
              }}
            />
            {testState.status === 'error' && (
              <span className='text-error text-end text-xs'>{testState.message}</span>
            )}
            {testState.status === 'success' && (
              <span className='text-success flex items-center gap-1 text-end text-xs'>
                <MdCheckCircle />
                {testState.message}
              </span>
            )}
          </div>
        </SettingsRow>
        <SettingsRow label={_('API host')} description={getHost(effectiveConfig?.apiBaseUrl, _)} />
        <SettingsRow
          label={_('Supabase host')}
          description={getHost(effectiveConfig?.supabaseUrl, _)}
        />
        <SettingsRow
          label={_('Supabase anon key')}
          description={maskAnonKey(effectiveConfig?.supabaseAnonKey, _)}
        />
        <SettingsRow
          label={_('Compatibility mode')}
          description={_('For official Docker deployments without public config discovery.')}
        >
          <button
            type='button'
            className='btn btn-ghost btn-sm'
            aria-expanded={compatibilityExpanded}
            onClick={() => {
              setCompatibilityExpanded((value) => !value);
              if (!apiBaseUrl) setApiBaseUrl(serverUrl);
              setTestState({ status: 'idle' });
            }}
          >
            {_('Official Docker compatibility')}
          </button>
        </SettingsRow>
        {compatibilityExpanded && (
          <>
            <SettingsRow
              label={_('API base URL')}
              description={_('Optional. Defaults to the server URL.')}
              align='start'
            >
              <input
                aria-label={_('API base URL')}
                className='input settings-content input-bordered eink-bordered h-9 w-full rounded-md text-end sm:max-w-[60%]'
                value={apiBaseUrl}
                placeholder='https://readest.example.com'
                onChange={(event) => {
                  setApiBaseUrl(event.target.value);
                  setTestState({ status: 'idle' });
                }}
              />
            </SettingsRow>
            <SettingsRow label={_('Supabase public URL')} align='start'>
              <input
                aria-label={_('Supabase public URL')}
                className='input settings-content input-bordered eink-bordered h-9 w-full rounded-md text-end sm:max-w-[60%]'
                value={supabaseUrl}
                placeholder='https://supabase.example.com'
                onChange={(event) => {
                  setSupabaseUrl(event.target.value);
                  setTestState({ status: 'idle' });
                }}
              />
            </SettingsRow>
            <SettingsRow
              label={_('Supabase anon or publishable key')}
              description={_('Public client key only. Service-role and secret keys are rejected.')}
              align='start'
            >
              <input
                aria-label={_('Supabase anon or publishable key')}
                type='password'
                autoComplete='off'
                className='input settings-content input-bordered eink-bordered h-9 w-full rounded-md text-end sm:max-w-[60%]'
                value={supabaseAnonKey}
                onChange={(event) => {
                  setSupabaseAnonKey(event.target.value);
                  setTestState({ status: 'idle' });
                }}
              />
            </SettingsRow>
          </>
        )}
        <SettingsRow label={_('Actions')} align='start'>
          <div className='flex flex-wrap justify-end gap-2'>
            <button
              type='button'
              className='btn btn-sm'
              disabled={!serverUrl.trim() || isTesting}
              onClick={handleTestConnection}
            >
              <MdSettingsEthernet />
              {_('Test connection')}
            </button>
            <button
              type='button'
              className='btn btn-contrast btn-sm'
              disabled={!serverUrl.trim() || isSaving}
              onClick={handleSave}
            >
              <MdSave />
              {_('Save')}
            </button>
            <button
              type='button'
              className='btn btn-ghost btn-sm'
              disabled={isResetting || (!savedConfig && !serverUrl)}
              onClick={handleReset}
            >
              <MdRefresh />
              {_('Reset to default')}
            </button>
          </div>
        </SettingsRow>
      </BoxedList>
    </div>
  );
};

export default ServerSettingsPanel;
