import React from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "@dynatrace/strato-components-preview/layouts";

export const Header = () => (
  <AppHeader>
    <AppHeader.Navigation>
      <AppHeader.Logo as={Link} to="/" />
    </AppHeader.Navigation>
  </AppHeader>
);
