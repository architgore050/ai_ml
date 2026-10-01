import React, { createContext, useContext, useEffect, useState } from "react";
import { authAPI, getStoredTokens, getStoredUser, profileAPI, setStoredTokens, setStoredUser } from "../api/client";
import { OwnProfile, User } from "../types/echoflow";

interface AuthContextType {
  user: User | null;
  profile: OwnProfile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (params: {
    email: string;
    username: string;
    password: string;
    dob: string;
    parentEmail?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshProfile = async () => {
    try {
      const myProfile = await profileAPI.getMyProfile();
      setProfile(myProfile);
      const updatedUser: User = {
        id: myProfile.id,
        username: myProfile.username,
        email: myProfile.email,
      };
      setUser(updatedUser);
      setStoredUser(updatedUser);
    } catch (err) {
      console.warn("Could not fetch user profile:", err);
    }
  };

  useEffect(() => {
    const tokens = getStoredTokens();
    if (tokens?.access) {
      refreshProfile().finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }

    const handleSessionExpired = () => {
      setUser(null);
      setProfile(null);
      setStoredTokens(null);
      setStoredUser(null);
    };

    window.addEventListener("ef_session_expired", handleSessionExpired);
    return () => window.removeEventListener("ef_session_expired", handleSessionExpired);
  }, []);

  const login = async (username: string, password: string) => {
    await authAPI.login(username, password);
    await refreshProfile();
  };

  // Spec FR-AUTH-1: register then immediately login to obtain tokens
  const register = async ({
    email,
    username,
    password,
    dob,
    parentEmail,
  }: {
    email: string;
    username: string;
    password: string;
    dob: string;
    parentEmail?: string;
  }) => {
    // A1 / ISSUE-16: the accepted terms versions are a server contract, so
    // read them from /legal/compliance/ rather than hardcoding. Falls back to
    // the documented default if that fetch fails, because registration
    // cannot proceed without some version and a stale-but-valid one beats a
    // 400 with no cause. If the server does reject it, its error lists the
    // allowed values, so the failure is self-explaining.
    let termsVersion = "v1.0";
    try {
      const compliance = await authAPI.getCompliance();
      if (compliance.current_terms_version) {
        termsVersion = compliance.current_terms_version;
      }
    } catch {
      // Leave the default. A metadata fetch must not block registration.
    }

    await authAPI.register(username, email, password, termsVersion, dob, parentEmail);
    await authAPI.login(username, password);
    sessionStorage.setItem("ef_new_user", "1");
    await refreshProfile();
  };

  // Spec FR-AUTH-4: call backend logout to blacklist refresh token
  const logout = async () => {
    await authAPI.logout();
    setUser(null);
    setProfile(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        isAuthenticated: !!user,
        isLoading,
        login,
        register,
        logout,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
