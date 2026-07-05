import {
  createHashRouter,
  RouterProvider,
  Navigate,
} from "react-router-dom";
import { Layout } from "./components/Layout";
import { CasesBoard } from "./pages/CasesBoard";
import { ExplorePage } from "./pages/Explore";
import { ModelConfigPage } from "./pages/ModelConfig";
import { ChainConfigPage } from "./pages/ChainConfig";
import { RunReportPage } from "./pages/RunReport";
import { ProjectsPage } from "./pages/Projects";
import { SuitePage } from "./pages/Suite";
import { TrendsPage } from "./pages/Trends";

const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "explore", element: <ExplorePage /> },
      { path: "cases", element: <CasesBoard /> },
      { path: "suite", element: <SuitePage /> },
      { path: "trends", element: <TrendsPage /> },
      { path: "runs", element: <RunReportPage /> },
      { path: "model", element: <ModelConfigPage /> },
      { path: "chain", element: <ChainConfigPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
