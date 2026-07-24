import type { Metadata } from "next";
import AutoproverDashboard from "./components/AutoproverDashboard";

export const metadata: Metadata = {
  title: "Continuous Math Research",
  description:
    "See which open mathematical problems are being worked on, verified, solved, or left unresolved.",
};

export default function Home() {
  return <AutoproverDashboard />;
}
