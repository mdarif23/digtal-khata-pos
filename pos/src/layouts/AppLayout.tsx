import { AppSidebar } from "@/components/app-sidebar";
import { AppHeader } from "@/components/layout/AppHeader";
import {
  SidebarInset,
  SidebarProvider,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Outlet } from "react-router";

export default function AppLayout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <AppHeader />
        <main className="relative flex-1">
          <Outlet />
        </main>
        <SidebarRail />
      </SidebarInset>
    </SidebarProvider>
  );
}
