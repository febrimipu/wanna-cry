import bcrypt from "bcrypt";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db";

export type Role = "admin" | "operator" | "viewer";

export type SessionUser = {
  id: string;
  email: string;
  role: Role;
};

export function verifyLogin(
  email: string,
  password: string,
): SessionUser | null {
  const normalizedEmail = String(email || "")
    .trim()
    .toLowerCase();
  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(normalizedEmail) as any;
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  return { id: user.id, email: user.email, role: user.role as Role };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session?.user) return res.redirect("/login");
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.session?.user;
    if (!user || !roles.includes(user.role))
      return res.status(403).send("Forbidden");
    next();
  };
}
