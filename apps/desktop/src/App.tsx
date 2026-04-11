import { useSessionStore } from "./store/session";
import { Home } from "./pages/Home";
import { Session } from "./pages/Session";
import { JoinSession } from "./pages/JoinSession";
import { Toast } from "./components/Toast";

export default function App() {
  const { view } = useSessionStore();

  return (
    <div className="app-root">
      <Toast />
      {view === "session" ? <Session /> : view === "join" ? <JoinSession /> : <Home />}
    </div>
  );
}
