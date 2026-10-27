import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/** Local UI keeps credentials in request memory only; no browser persistence is installed. */
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
