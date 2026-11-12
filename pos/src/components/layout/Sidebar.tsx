import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router";
import {
  RiMenuFold4Line,
  RiMenuUnfold4Line,
  RiDashboardFill,
  RiProductHuntFill,
  RiArchiveDrawerFill,
  RiMoneyDollarBoxFill,
  RiUserFill,
  RiFileList2Fill,
} from "react-icons/ri";
import { MdPointOfSale, MdManageAccounts } from "react-icons/md";
import { usePermissions } from "@/hooks/usePermissions";

/* ------------------ MENU CONFIG ------------------ */
interface MenuItem {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  path: string;
  /** Visible only when the caller holds ANY of these permissions. */
  anyPermission?: string[];
}

const MENU_ITEMS: MenuItem[] = [
  { label: "Dashboard", icon: RiDashboardFill, path: "/dashboard" },
  { label: "POS", icon: MdPointOfSale, path: "/" },
  {
    label: "Register",
    icon: RiArchiveDrawerFill,
    path: "/register",
    anyPermission: ["cash_register.view"],
  },
  { label: "Products", icon: RiProductHuntFill, path: "/product" },
  { label: "Sales", icon: RiMoneyDollarBoxFill, path: "/sales" },
  { label: "Expense", icon: RiArchiveDrawerFill, path: "/expense" },
  { label: "Customers", icon: MdManageAccounts, path: "/customer" },
  { label: "Purchases Order", icon: MdManageAccounts, path: "/purchases" },
  { label: "Purchases List", icon: MdManageAccounts, path: "/purchases-list" },
  {
    label: "Audit Log",
    icon: RiFileList2Fill,
    path: "/audit-logs",
    anyPermission: ["audit.view"],
  },
  {
    label: "Hardware",
    icon: RiUserFill,
    path: "/settings/hardware",
    anyPermission: [
      "pos_terminal.view",
      "cash_drawer.open",
      "cash_drawer.open_without_sale",
    ],
  },
];

/* ------------------ SIDEBAR ------------------ */
export default function Sidebar() {
  const [active, setActive] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const { hasAnyPermission } = usePermissions();

  const items = MENU_ITEMS.filter(
    (item) => item.anyPermission === undefined || hasAnyPermission(item.anyPermission),
  );

  useEffect(() => {
    const current = MENU_ITEMS.find((item) => item.path === location.pathname);
    if (current) setActive(current.label);
  }, [location.pathname]);

  return (
    <aside className="h-screen bg-gray-900 text-white flex flex-col transition-all duration-300 w-full ">
      {/* ---------- HEADER ---------- */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-gray-800">
        <h1 className="text-lg font-semibold tracking-wide">My POS</h1>
        <RiMenuUnfold4Line className="text-2xl" />
      </div>

      {/* ---------- MENU ---------- */}
      <nav className="flex-1 overflow-y-auto no-scrollbar py-2">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.label;

          return (
            <div
              key={item.label}
              onClick={() => navigate(item.path)}
              className={`group relative mx-2 my-1 rounded-lg cursor-pointer transition-all
                ${
                  isActive
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:bg-gray-800 hover:text-white"
                }`}
            >
              {/* Active indicator */}
              {isActive && (
                <span className="absolute left-0 top-0 h-full w-1 bg-blue-500 rounded-l-lg" />
              )}

              <div className="flex items-center gap-4 px-3 py-3">
                <Icon className="text-2xl shrink-0" />

                <span className="text-sm font-medium tracking-wide">
                  {item.label}
                </span>
              </div>
            </div>
          );
        })}
      </nav>

      {/* ---------- FOOTER ---------- */}
      <div className="border-t border-gray-800 px-3 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <RiUserFill className="text-2xl" />

          <div>
            <p className="text-sm font-medium">Arif</p>
            <p className="text-xs text-gray-400">Admin</p>
          </div>
        </div>

        <button className="text-xl hover:text-gray-300">
          <MdManageAccounts />
        </button>
      </div>
    </aside>
  );
}
