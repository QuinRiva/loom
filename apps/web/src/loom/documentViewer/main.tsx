import "@fontsource-variable/inter";
import "../../index.css";
import "./documentViewer.css";

import { createRoot } from "react-dom/client";

import { DocumentViewerApp } from "./DocumentViewerApp";

createRoot(document.getElementById("root")!).render(<DocumentViewerApp />);
