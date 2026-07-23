/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  AutoComplete,
  Banner,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Radio,
  RadioGroup,
  Select,
  TabPane,
  Tabs,
  TimePicker,
  Toast,
  Typography,
} from '@douyinfe/semi-ui-19';
import { IconFolder, IconHome, IconPulse, IconRefresh, IconSave, IconSignal, IconUser } from '@douyinfe/semi-icons';
import { useActions, useIsLoading, useSelector } from '../../services/state/store.js';
import { availableLanguages, useTranslation } from '../../services/i18n/i18n.jsx';
import { xhrGet, xhrPost } from '../../services/xhr.js';
import {
  downloadBackup as downloadBackupZip,
  precheckRestore as clientPrecheckRestore,
  restore as clientRestore,
} from '../../services/backupRestoreClient.js';
import { SegmentPart } from '../../components/segment/SegmentPart.jsx';
import Headline from '../../components/headline/Headline.jsx';
import { debounce } from '../../utils.js';
import './GeneralSettings.less';

const { Text } = Typography;

function formatFromTimestamp(timestamp) {
  const date = new Date(timestamp);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatForTimePicker(value) {
  if (!value) return null;
  const [hours, minutes] = value.split(':');
  const date = new Date();
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return date.getTime();
}

export default function GeneralSettings() {
  const t = useTranslation();
  const actions = useActions();
  const settings = useSelector((state) => state.generalSettings.settings);
  const userSettings = useSelector((state) => state.userSettings.settings);
  const savingUser = useIsLoading(actions.userSettings.setHomeAddress);
  const fileInputRef = React.useRef(null);

  const [loading, setLoading] = useState(true);
  const [port, setPort] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [sessionTTL, setSessionTTL] = useState('');
  const [sqlitePath, setSqlitePath] = useState('');
  const [interval, setInterval] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [workingHourFrom, setWorkingHourFrom] = useState(null);
  const [workingHourTo, setWorkingHourTo] = useState(null);

  const [address, setAddress] = useState('');
  const [coords, setCoords] = useState(null);
  const [listingDeleteHard, setListingDeleteHard] = useState(false);
  const [listingDeleteSkipPrompt, setListingDeleteSkipPrompt] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState([]);

  const [account, setAccount] = useState({ username: '', password: '', password2: '' });
  const [accountSaving, setAccountSaving] = useState(false);
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(false);

  const [restoreModalVisible, setRestoreModalVisible] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreInfo, setRestoreInfo] = useState(null);
  const [restoreFile, setRestoreFile] = useState(null);

  useEffect(() => {
    async function initialize() {
      await Promise.all([actions.generalSettings.getGeneralSettings(), actions.userSettings.getUserSettings()]);
      try {
        const response = await xhrGet('/api/account');
        setAccount((current) => ({ ...current, username: response.json.username || '' }));
      } catch {
        Toast.error(t('settings.accountLoadError'));
      }
      setLoading(false);
    }
    initialize();
  }, []);

  useEffect(() => {
    setPort(settings?.port ?? '');
    setBaseUrl(settings?.baseUrl ?? '');
    setSessionTTL(settings?.sessionTTL ?? '');
    setSqlitePath(settings?.sqlitepath ?? '');
    setInterval(settings?.interval ?? '');
    setProxyUrl(settings?.proxyUrl ?? '');
    setWorkingHourFrom(settings?.workingHours?.from ?? null);
    setWorkingHourTo(settings?.workingHours?.to ?? null);
  }, [settings]);

  useEffect(() => {
    setAddress(userSettings?.home_address?.address || '');
    setCoords(userSettings?.home_address?.coords || null);
    setListingDeleteHard(userSettings?.listing_deletion_preference?.hardDelete ?? false);
    setListingDeleteSkipPrompt(userSettings?.listing_deletion_preference?.skipPrompt ?? false);
  }, [userSettings]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch('/health', { credentials: 'include' });
        const payload = await response.json();
        if (!cancelled) {
          setHealth(payload);
          setHealthError(!response.ok);
        }
      } catch {
        if (!cancelled) setHealthError(true);
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const searchAddress = useMemo(
    () =>
      debounce((value) => {
        if (!value) return setAddressSuggestions([]);
        xhrGet(`/api/user/settings/autocomplete?q=${encodeURIComponent(value)}`)
          .then((response) => setAddressSuggestions(response.json))
          .catch(() => setAddressSuggestions([]));
      }, 300),
    [],
  );

  const saveRuntimeSettings = async () => {
    if (!interval || !port || !sqlitePath) {
      Toast.error(t('settings.toastSaveError'));
      return;
    }
    if (Boolean(workingHourFrom) !== Boolean(workingHourTo)) {
      Toast.error(t('settings.toastWorkingHoursIncomplete'));
      return;
    }
    try {
      await xhrPost('/api/admin/generalSettings', {
        port,
        baseUrl,
        sessionTTL,
        sqlitepath: sqlitePath,
        interval,
        proxyUrl: proxyUrl.trim(),
        workingHours: { from: workingHourFrom, to: workingHourTo },
      });
      Toast.success(t('settings.toastSavedReloading'));
      window.setTimeout(() => window.location.reload(), 3000);
    } catch (error) {
      Toast.error(error?.json?.error || t('settings.toastSaveError'));
    }
  };

  const saveUserSettings = async () => {
    try {
      const result = await actions.userSettings.setHomeAddress(address);
      setCoords(result.coords);
      await actions.userSettings.setListingDeletionPreference({
        hardDelete: listingDeleteHard,
        skipPrompt: listingDeleteSkipPrompt,
      });
      Toast.success(t('settings.userSettingsSaved'));
    } catch (error) {
      Toast.error(error?.json?.error || t('settings.userSettingsSaveError'));
    }
  };

  const saveAccount = async () => {
    if (!account.username.trim() || account.password !== account.password2) {
      Toast.error(t('settings.accountValidationError'));
      return;
    }
    setAccountSaving(true);
    try {
      await xhrPost('/api/account', account);
      setAccount((current) => ({ ...current, password: '', password2: '' }));
      Toast.success(t('settings.accountSaved'));
    } catch (error) {
      Toast.error(error?.json?.error || t('settings.accountSaveError'));
    } finally {
      setAccountSaving(false);
    }
  };

  const selectRestore = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      setRestoreFile(file);
      setRestoreInfo(await clientPrecheckRestore(file));
      setRestoreModalVisible(true);
    } catch {
      Toast.error(t('settings.backupAnalyzeError'));
    }
  };

  const restoreBackup = async () => {
    setRestoreBusy(true);
    try {
      await clientRestore(restoreFile, !restoreInfo?.compatible);
      Toast.success(t('settings.backupRestoreCompleted'));
      setRestoreModalVisible(false);
    } catch (error) {
      Toast.error(error?.message || t('settings.backupRestoreError'));
    } finally {
      setRestoreBusy(false);
    }
  };

  if (loading) return null;

  return (
    <div className="generalSettings">
      <Headline text={t('settings.title')} />
      <Tabs type="line">
        <TabPane tab={<span><IconSignal size="small" /> {t('settings.tabSystem')}</span>} itemKey="system">
          <div className="generalSettings__tab-content">
            <SegmentPart name={t('settings.port')} helpText={t('settings.portHelp')}>
              <InputNumber value={port} min={1} max={65535} onChange={setPort} />
            </SegmentPart>
            <SegmentPart name={t('settings.baseUrl')} helpText={t('settings.baseUrlHelp')}>
              <Input value={baseUrl} onChange={setBaseUrl} placeholder={t('settings.baseUrlPlaceholder')} />
            </SegmentPart>
            <SegmentPart name={t('settings.sessionTTL')} helpText={t('settings.sessionTTLHelp')}>
              <InputNumber value={sessionTTL} min={1} onChange={setSessionTTL} />
            </SegmentPart>
            <SegmentPart name={t('settings.sqlitePath')} helpText={t('settings.sqlitePathHelp')}>
              <Banner type="warning" fullMode={false} closeIcon={null} description={t('settings.sqlitePathWarning')} />
              <Input value={sqlitePath} onChange={setSqlitePath} />
            </SegmentPart>
            <div className="generalSettings__save-row">
              <Button theme="solid" type="primary" icon={<IconSave />} onClick={saveRuntimeSettings}>{t('settings.save')}</Button>
            </div>
          </div>
        </TabPane>

        <TabPane tab={<span><IconRefresh size="small" /> {t('settings.tabExecution')}</span>} itemKey="execution">
          <div className="generalSettings__tab-content">
            <SegmentPart name={t('settings.searchInterval')} helpText={t('settings.searchIntervalHelp')}>
              <InputNumber value={interval} min={5} max={1440} suffix={t('settings.searchIntervalSuffix')} onChange={setInterval} />
            </SegmentPart>
            <SegmentPart name={t('settings.workingHours')} helpText={t('settings.workingHoursHelp')}>
              <div className="generalSettings__timePickerContainer">
                <TimePicker
                  format="HH:mm"
                  insetLabel={t('settings.workingHoursFrom')}
                  value={formatForTimePicker(workingHourFrom)}
                  onChange={(value) => setWorkingHourFrom(value == null ? null : formatFromTimestamp(value))}
                />
                <TimePicker
                  format="HH:mm"
                  insetLabel={t('settings.workingHoursUntil')}
                  value={formatForTimePicker(workingHourTo)}
                  onChange={(value) => setWorkingHourTo(value == null ? null : formatFromTimestamp(value))}
                />
              </div>
            </SegmentPart>
            <SegmentPart name={t('settings.proxyUrl')} helpText={t('settings.proxyUrlHelp')}>
              <Input value={proxyUrl} onChange={setProxyUrl} placeholder={t('settings.proxyUrlPlaceholder')} />
            </SegmentPart>
            <div className="generalSettings__save-row">
              <Button theme="solid" type="primary" icon={<IconSave />} onClick={saveRuntimeSettings}>{t('settings.save')}</Button>
            </div>
          </div>
        </TabPane>

        <TabPane tab={<span><IconHome size="small" /> {t('settings.tabUserSettings')}</span>} itemKey="preferences">
          <div className="generalSettings__tab-content">
            <SegmentPart name={t('settings.language')} helpText={t('settings.languageHelp')}>
              <Select
                value={userSettings?.language ?? 'en'}
                optionList={availableLanguages.map((language) => ({
                  label: `${language.flag} ${language.name}`,
                  value: language.code,
                }))}
                onChange={(value) => actions.userSettings.setLanguage(value)}
              />
            </SegmentPart>
            <SegmentPart name={t('settings.homeAddress')} helpText={t('settings.homeAddressHelp')}>
              <AutoComplete
                data={addressSuggestions}
                value={address}
                showClear
                onChange={setAddress}
                onSearch={searchAddress}
                style={{ width: '100%' }}
              />
              {coords?.lat === -1 && <Banner type="danger" closeIcon={null} description={t('settings.homeAddressGeoError')} />}
            </SegmentPart>
            <SegmentPart name={t('settings.listingDeletion')} helpText={t('settings.listingDeletionHelp')}>
              <RadioGroup value={listingDeleteHard ? 'hard' : 'soft'} onChange={(event) => setListingDeleteHard(event.target.value === 'hard')}>
                <Radio value="soft"><Text strong>{t('settings.listingDeletionSoftLabel')}</Text></Radio>
                <Radio value="hard"><Text strong>{t('settings.listingDeletionHardLabel')}</Text></Radio>
              </RadioGroup>
              <Checkbox checked={listingDeleteSkipPrompt} onChange={(event) => setListingDeleteSkipPrompt(event.target.checked)}>
                {t('settings.listingDeletionSkipPrompt')}
              </Checkbox>
            </SegmentPart>
            <div className="generalSettings__save-row">
              <Button theme="solid" type="primary" icon={<IconSave />} loading={savingUser} onClick={saveUserSettings}>{t('settings.save')}</Button>
            </div>
          </div>
        </TabPane>

        <TabPane tab={<span><IconUser size="small" /> {t('settings.tabAccount')}</span>} itemKey="account">
          <div className="generalSettings__tab-content">
            <SegmentPart name={t('settings.accountUsername')}>
              <Input value={account.username} onChange={(username) => setAccount((current) => ({ ...current, username }))} />
            </SegmentPart>
            <SegmentPart name={t('settings.accountPassword')} helpText={t('settings.accountPasswordHelp')}>
              <Input mode="password" value={account.password} onChange={(password) => setAccount((current) => ({ ...current, password }))} />
            </SegmentPart>
            <SegmentPart name={t('settings.accountPasswordRepeat')}>
              <Input mode="password" value={account.password2} onChange={(password2) => setAccount((current) => ({ ...current, password2 }))} />
            </SegmentPart>
            <div className="generalSettings__save-row">
              <Button theme="solid" type="primary" icon={<IconSave />} loading={accountSaving} onClick={saveAccount}>{t('settings.save')}</Button>
            </div>
          </div>
        </TabPane>

        <TabPane tab={<span><IconPulse size="small" /> {t('settings.tabRuntime')}</span>} itemKey="runtime">
          <div className="generalSettings__tab-content">
            <Banner
              type={!healthError && health?.status === 'ok' ? 'success' : 'danger'}
              fullMode={false}
              closeIcon={null}
              title={t(!healthError && health?.status === 'ok' ? 'settings.runtimeHealthy' : 'settings.runtimeUnhealthy')}
              description={health ? Object.entries(health.checks || {}).map(([name, ok]) => `${name}: ${ok ? 'ok' : 'failed'}`).join(' · ') : t('settings.runtimeUnavailable')}
            />
            <SegmentPart name={t('settings.runtimeWorkers')}>
              <div className="generalSettings__workers">
                {(health?.workers || []).map((worker) => (
                  <div key={worker.name}>
                    <Text strong>{worker.name}</Text>
                    <Text type={worker.healthy ? 'success' : 'danger'}>
                      {worker.healthy ? t('settings.runtimeWorkerHealthy') : t('settings.runtimeWorkerUnhealthy')}
                    </Text>
                    <Text type="secondary">
                      {t('settings.runtimeWorkerCounts', { completed: worker.completedItems, failed: worker.failedItems })}
                    </Text>
                  </div>
                ))}
              </div>
            </SegmentPart>
          </div>
        </TabPane>

        <TabPane tab={<span><IconFolder size="small" /> {t('settings.tabBackup')}</span>} itemKey="backup">
          <div className="generalSettings__tab-content">
            <SegmentPart name={t('settings.backupSectionName')} helpText={t('settings.backupHelp')}>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button icon={<IconSave />} onClick={async () => {
                  try { await downloadBackupZip(); } catch { Toast.error(t('settings.backupDownloadError')); }
                }}>{t('settings.backupDownload')}</Button>
                <input ref={fileInputRef} type="file" accept=".zip,application/zip" hidden onChange={selectRestore} />
                <Button icon={<IconFolder />} onClick={() => fileInputRef.current?.click()}>{t('settings.backupRestoreFromZip')}</Button>
              </div>
            </SegmentPart>
          </div>
        </TabPane>
      </Tabs>

      <Modal
        title={t('settings.restoreModalTitle')}
        visible={restoreModalVisible}
        onCancel={() => setRestoreModalVisible(false)}
        onOk={restoreBackup}
        okText={restoreInfo?.compatible ? t('settings.restoreNow') : t('settings.restoreAnyway')}
        okType={restoreInfo?.compatible ? 'primary' : 'danger'}
        confirmLoading={restoreBusy}
      >
        <Banner
          type={restoreInfo?.severity === 'danger' ? 'danger' : restoreInfo?.severity === 'warning' ? 'warning' : 'success'}
          fullMode={false}
          closeIcon={null}
          description={restoreInfo?.message}
        />
      </Modal>
    </div>
  );
}
