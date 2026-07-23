/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import React from 'react';

import cityBackground from '../../assets/city_background.jpg';
import Logo from '../../components/logo/Logo';
import { xhrPost } from '../../services/xhr';
import { useLocation, useNavigate } from 'react-router-dom';
import { useActions } from '../../services/state/store';
import { Input, Button, Banner } from '@douyinfe/semi-ui-19';

import './login.less';
import { IconUser, IconLock } from '@douyinfe/semi-icons';
import { useTranslation } from '../../services/i18n/i18n.jsx';

export default function Login() {
  const t = useTranslation();
  const actions = useActions();
  const [username, setUserName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState(null);
  const navigate = useNavigate();
  const location = useLocation();

  const tryLogin = async () => {
    if (!username?.trim() || !password) {
      setError(t('login.errorMandatory'));
      return;
    }
    setError(null);

    try {
      await xhrPost('/api/login', {
        username: username.trim(),
        password,
      });
      /* eslint-disable no-unused-vars */
    } catch (ignored) {
      setError(t('login.errorInvalid'));
      return;
    }

    await actions.user.getCurrentUser();
    navigate(location.state?.from?.pathname || '/dashboard');
  };

  return (
    <div className="login">
      <div className="login__bgImage" style={{ background: `url("${cityBackground}")` }} />
      <div className="login__loginWrapper">
        <div className="login__logoWrapper">
          <Logo width={250} white />
        </div>

        <form onSubmit={(e) => e.preventDefault()}>
          {error && <Banner type="danger" closeIcon={null} description={error} style={{ marginBottom: '1rem' }} />}
          <div className="login__inputGroup">
            <Input
              size="large"
              prefix={<IconUser />}
              placeholder={t('login.usernamePlaceholder')}
              value={username}
              showClear
              autoFocus
              onChange={(value) => setUserName(value)}
              onKeyPress={async (e) => {
                if (e.key === 'Enter') {
                  await tryLogin();
                }
              }}
            />
          </div>

          <div className="login__inputGroup">
            <Input
              size="large"
              mode="password"
              prefix={<IconLock />}
              value={password}
              placeholder={t('login.passwordPlaceholder')}
              onChange={(value) => setPassword(value)}
              onKeyPress={async (e) => {
                if (e.key === 'Enter') {
                  await tryLogin();
                }
              }}
            />
          </div>

          <Button block type="primary" onClick={tryLogin} theme="solid" style={{ marginTop: '1rem' }}>
            {t('login.loginButton')}
          </Button>
        </form>
      </div>
    </div>
  );
}

Login.displayName = 'Login';
