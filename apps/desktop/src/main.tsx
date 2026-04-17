import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { initEventListeners } from "./store/session";

initEventListeners();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
