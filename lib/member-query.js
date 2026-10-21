export function memberQuery(params) {
  const page = params.get("usersPage") || "1";
  const search = (params.get("usersSearch") || "").trim().toLowerCase();
  if (
    !/^[1-9]\d{0,5}$/.test(page) ||
    search.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(search)
  )
    throw Object.assign(new Error("راجع البحث ورقم صفحة الحسابات."), {
      status: 400,
    });
  return { page: Number(page), pageSize: 20, search };
}
