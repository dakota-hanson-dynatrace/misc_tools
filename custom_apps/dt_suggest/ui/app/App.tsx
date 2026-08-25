import { PageLayout } from "@dynatrace/strato-components/layouts";
import React from "react";
import { Route, Routes } from "react-router-dom";
import { Header } from "./components/Header";
import { Issues } from "./pages/Issues";

export const App = () => (
  <PageLayout>
    <PageLayout.Header>
      <Header />
    </PageLayout.Header>
    <PageLayout.Content>
      <Routes>
        <Route path="/" element={<Issues />} />
      </Routes>
    </PageLayout.Content>
  </PageLayout>
);
