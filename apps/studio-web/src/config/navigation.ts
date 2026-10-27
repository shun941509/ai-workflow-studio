/** Product navigation is centralized so official and community collections stay distinct. */
export const navigation = [
  { href: "/", label: "홈", icon: "home" },
  { href: "/projects", label: "내 프로젝트", icon: "folder" },
  { href: "/resources", label: "도구 및 자료", icon: "layers" },
  { href: "/explore/projects", label: "프로젝트 둘러보기", icon: "compass" },
  { href: "/explore/resources", label: "도구 및 자료 둘러보기", icon: "library" },
  { href: "/examples", label: "예제 프로젝트", icon: "sparkles" },
  { href: "/examples/resources", label: "예제 자료 및 도구", icon: "book" },
  { href: "/guide", label: "사용 가이드", icon: "help" }
] as const;
