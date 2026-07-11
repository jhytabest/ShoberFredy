/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import ShibaLogo from './ShibaLogo.jsx';

import './Logo.less';

export default function Logo({ width = 350, white = false } = {}) {
  return (
    <span className="logo">
      <ShibaLogo width={width} white={white} />
    </span>
  );
}
