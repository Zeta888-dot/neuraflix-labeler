import {
  BookOpen,
  ChatsCircle,
  GearSix,
  ListChecks,
  Scan,
  SealCheck,
  SquaresFour,
  TextT,
  UploadSimple,
  UserCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { Role } from "@/lib/types";

export type NavItem = {
  href: string;
  label: string;
  icon: Icon;
  /** When set, only these roles see the item. */
  roles?: Role[];
  /** When true, only the exact path is active, not its children. */
  exact?: boolean;
};

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: SquaresFour },
  { href: "/instructions", label: "Instructions", icon: ListChecks },
  { href: "/conversations", label: "Conversations", icon: ChatsCircle },
  { href: "/plain-text", label: "Plain text", icon: TextT },
  { href: "/ocr", label: "OCR pages", icon: Scan },
  {
    href: "/review",
    label: "Review",
    icon: SealCheck,
    roles: ["reviewer", "admin"],
  },
  {
    href: "/admin",
    label: "Admin",
    icon: GearSix,
    roles: ["admin"],
    exact: true,
  },
  {
    href: "/admin/upload",
    label: "Upload",
    icon: UploadSimple,
    roles: ["admin"],
  },
  { href: "/guidelines", label: "Guidelines", icon: BookOpen },
  { href: "/account", label: "Account", icon: UserCircle },
];

export function visibleNavItems(role: Role): NavItem[] {
  return navItems.filter((item) => !item.roles || item.roles.includes(role));
}

export function isActivePath(
  pathname: string,
  href: string,
  exact = false,
): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
