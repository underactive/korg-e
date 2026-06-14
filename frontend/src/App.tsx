import { ReactFlowProvider } from "@xyflow/react";
import FlowCanvas from "@/components/Canvas";
import Toolbar from "@/components/Toolbar";

export default function App() {
  return (
    <ReactFlowProvider>
      <Toolbar />
      <FlowCanvas />
    </ReactFlowProvider>
  );
}
