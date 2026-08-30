import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Overview from "@/pages/Overview";
import Builder from "@/pages/Builder";
import Campaign from "@/pages/Campaign";
import Journal from "@/pages/Journal";
import Cockpit from "@/pages/Cockpit";
import { Shell } from "@/components/app/Shell";
import { ExtremeTracker } from "@/components/app/ExtremeTracker";

function AppRouter() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/cockpit" component={Cockpit} />
        <Route path="/builder" component={Builder} />
        <Route path="/campaign" component={Campaign} />
        <Route path="/journal" component={Journal} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        {/* Runs globally so peak-profit/peak-loss tracking continues on any tab, not just Cockpit. */}
        <ExtremeTracker />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
