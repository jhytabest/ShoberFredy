/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React, { useEffect } from 'react';

import GeneralSettings from './views/generalSettings/GeneralSettings';
import JobMutation from './views/jobs/mutation/JobMutation';
import { useActions, useSelector } from './services/state/store';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Login from './views/login/Login';
import Jobs from './views/jobs/Jobs';

import './App.less';
import { LocaleProvider } from '@douyinfe/semi-ui-19';
import Listings from './views/listings/Listings.jsx';
import MapView from './views/listings/Map.jsx';
import Navigation from './components/navigation/Navigation.jsx';
import { Layout } from '@douyinfe/semi-ui-19';
import FredyFooter from './components/footer/FredyFooter.jsx';
import Dashboard from './views/dashboard/Dashboard.jsx';
import ListingDetail from './views/listings/ListingDetail.jsx';
import { I18nProvider, availableLanguages } from './services/i18n/i18n.jsx';

const semiLocaleModules = import.meta.glob('/node_modules/@douyinfe/semi-ui-19/lib/es/locale/source/*.js', {
  eager: true,
});

const semiLocales = {};
for (const [path, mod] of Object.entries(semiLocaleModules)) {
  const name = path.match(/\/source\/(\w+)\.js$/)?.[1];
  if (name) semiLocales[name] = mod.default ?? mod;
}

export default function FredyApp() {
  const location = useLocation();
  const actions = useActions();
  const [loading, setLoading] = React.useState(true);
  const currentUser = useSelector((state) => state.user.currentUser);
  const language = useSelector((state) => state.userSettings.settings.language);

  useEffect(() => {
    async function init() {
      await actions.user.getCurrentUser();
      if (!needsLogin()) {
        await actions.provider.getProvider();
        await actions.jobsData.getJobs();
        await actions.generalSettings.getGeneralSettings();
        await actions.userSettings.getUserSettings();
      }
      setLoading(false);
    }

    init();
  }, [currentUser?.userId]);

  // When any request reports a 401 (expired session), drop the cached user. That flips
  // needsLogin() to true, so the router shows the login screen (carrying the current
  // location as `from` so the user is sent back here after re-authenticating).
  useEffect(() => {
    const onUnauthorized = () => actions.user.resetCurrentUser();
    window.addEventListener('fredy:unauthorized', onUnauthorized);
    return () => window.removeEventListener('fredy:unauthorized', onUnauthorized);
  }, []);

  const needsLogin = () => {
    return currentUser == null || Object.keys(currentUser).length === 0;
  };

  const { Sider, Content } = Layout;

  return loading ? null : (
    <I18nProvider language={language ?? 'en'}>
      <LocaleProvider
        locale={
          semiLocales[availableLanguages.find((l) => l.code === (language ?? 'en'))?.semiLocale] ?? semiLocales['en_US']
        }
      >
        {needsLogin() ? (
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<Navigate state={{ from: location }} to="/login" replace />} />
          </Routes>
        ) : (
          <Layout className="app">
            <Sider>
              <Navigation />
            </Sider>
            <Layout className="app__main">
              <Content className="app__content">
                <Routes>
                  <Route path="/jobs/new" element={<JobMutation />} />
                  <Route path="/jobs/edit/:jobId" element={<JobMutation />} />
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/jobs" element={<Jobs />} />
                  <Route path="/listings" element={<Listings />} />
                  <Route path="/listings/listing/:listingId" element={<ListingDetail />} />
                  <Route path="/map" element={<MapView />} />
                  <Route path="/userSettings" element={<Navigate to="/generalSettings" replace />} />
                  <Route path="/generalSettings" element={<GeneralSettings />} />

                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  {/* Catch-all: an authenticated user landing on an unknown path (e.g. still on
                      /login during the post-login transition) is sent to the dashboard instead
                      of matching no route. */}
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </Content>
              <FredyFooter />
            </Layout>
          </Layout>
        )}
      </LocaleProvider>
    </I18nProvider>
  );
}

FredyApp.displayName = 'FredyApp';
