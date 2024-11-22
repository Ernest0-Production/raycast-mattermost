import { LocalStorage, getPreferenceValues } from "@raycast/api";
import axios, { AxiosRequestConfig } from "axios";
import {
  UserProfile,
  Team,
  TeamsWithCount,
  Channel,
  OrderedChannelCategories,
  UserProfileStatus,
  CustomProfileStatus,
  durationToExpireDate,
  UserProfileStatusKind,
  UnreadMessageCount,
} from "./MattermostTypes";

export interface Preference {
  baseUrl: string;
  authorizationType: AuthorizationType;
  credentials: string;
}

type AuthorizationType = "logpass" | "token";

let isRefreshing = false;
let refreshSubscribers: ((token: string) => void)[] = [];
const MAX_RETRY_ATTEMPTS = 3;

const API_ERRORS = {
  UNAUTHORIZED: 401,
  MAX_RETRIES_EXCEEDED: 'Max retry attempts reached',
} as const;

class ApiError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function onRefreshed(token: string) {
  MattermostClient.token = token;
  refreshSubscribers.forEach((callback) => callback(token));
  refreshSubscribers = [];
}

function addRefreshSubscriber(callback: (token: string) => void) {
  refreshSubscribers.push(callback);
}

axios.interceptors.request.use((config) => {
  config.baseURL = getPreferenceValues<Preference>().baseUrl + "/api/v4";

  if (!config.url?.includes('/users/login')) {
    config.headers = {
      ...config.headers,
      'Authorization': `Bearer ${MattermostClient.token}`
    };
    console.log(`${config.method?.toUpperCase()} ${config.url}`);
  }

  return config;
});
axios.interceptors.response.use(
  (response) => {
    console.log('Response:', response.data);
    return response;
  },
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry && !originalRequest.url.includes('/users/login')) {
      originalRequest._retry = (originalRequest._retry || 0) + 1;

      if (originalRequest._retry > MAX_RETRY_ATTEMPTS) {
        return Promise.reject(new ApiError(API_ERRORS.MAX_RETRIES_EXCEEDED));
      }

      if (!isRefreshing) {
        isRefreshing = true;

        try {
          await MattermostClient.signIn();
          const newToken = MattermostClient.token;
          onRefreshed(newToken);

          originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
          return axios(originalRequest);
        } catch (refreshError) {
          refreshSubscribers = [];
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      }

      return new Promise((resolve) => {
        addRefreshSubscriber((token: string) => {
          originalRequest.headers['Authorization'] = `Bearer ${token}`;
          resolve(axios(originalRequest));
        });
      });
    }

    return Promise.reject(error);
  }
);

export class MattermostClient {
  static baseUrl(): string {
    return getPreferenceValues<Preference>().baseUrl + "/api/v4";
  }

  static token = "";

  static async wakeUpSession(): Promise<boolean> {
    const token = await LocalStorage.getItem<string>("mattermost-token");

    if (token == undefined) {
      await MattermostClient.login();
      return false;
    } else {
      this.token = token;
      return true;
    }
  }

  private static validateCredentials(credentials: string): [string, string] {
    const [username, password] = credentials.split(":");
    if (!username || !password) {
      throw new ApiError('Invalid credentials format. Expected "username:password"');
    }
    return [username, password];
  }

  static async signIn(): Promise<void> {
    const preference = getPreferenceValues<Preference>();
    const [username, password] = this.validateCredentials(preference.credentials);

    const response = await axios.post<UserProfile>('/users/login', {
      login_id: username,
      password: password,
    });

    const token = response.headers["token"];
    if (!token) {
      throw new ApiError('No token received from server');
    }

    this.token = token;
    console.log("Update token:", token);
    await LocalStorage.setItem("mattermost-token", token);
  }

  static async login(): Promise<void> {
    console.log("try login");
    const preference = getPreferenceValues<Preference>();

    switch (preference.authorizationType) {
      case "token":
        this.token = preference.credentials;
        return Promise.resolve();
      case "logpass": {
        if (this.token.length == 0) {
          return this.signIn();
        }

        console.log("Already logged with token: " + this.token);
        console.log("try validate token...");
        return this.getMe()
          .catch((error) => {
            if (error.message.includes("401")) {
              return this.signIn();
            }
          })
          .then();
      }
    }
  }

  static async getMe(): Promise<UserProfile> {
    return axios.get<UserProfile>("/users/me").then((response) => response.data);
  }

  static async getTeams(): Promise<Team[]> {
    return axios
      .get<TeamsWithCount | Team[]>("/teams")
      .then((response) => response.data)
      .then((data) => (data instanceof Array ? data : data.teams));
  }

  static async getMyChannels(teamId: string): Promise<Channel[]> {
    return axios
      .get<Channel[]>("/users/me/teams/" + teamId + "/channels")
      .then((response) => response.data);
  }

  static async getChannelCategories(teamId: string): Promise<OrderedChannelCategories> {
    return axios
      .get<OrderedChannelCategories>("/users/me/teams/" + teamId + "/channels/categories")
      .then((response) => response.data);
  }

  static async getProfilesByIds(ids: string[]): Promise<UserProfile[]> {
    return axios
      .post<UserProfile[]>("/users/ids", JSON.stringify(ids))
      .then((response) => response.data);
  }

  static async getProfileStatus(): Promise<UserProfileStatus> {
    return axios.get<UserProfileStatus>("/users/me/status").then((response) => response.data);
  }

  static async setProfileStatus(user_id: string, status: UserProfileStatusKind): Promise<void> {
    return axios
      .put<void>(
        "/users/me/status",
        JSON.stringify({
          user_id: user_id,
          status: status,
        })
      )
      .then((response) => response.data);
  }

  static async getProfilesStatus(ids: string[]): Promise<UserProfileStatus[]> {
    return axios
      .post<UserProfileStatus[]>("/users/status/ids", JSON.stringify(ids))
      .then((response) => response.data);
  }

  static async setCustomStatus(status: CustomProfileStatus): Promise<void> {
    return axios
      .put<void>(
        "/users/me/status/custom",
        JSON.stringify({
          emoji: status.emojiCode,
          text: status.text,
          duration: status.duration,
          expires_at: status.expires_at ?? (status.duration && durationToExpireDate(status.duration)),
        })
      )
      .then((response) => response.data);
  }

  static async clearCustomStatus(): Promise<void> {
    return axios.delete<void>("/users/me/status/custom").then((response) => response.data);
  }

  static async getUnreadMessages(teamId: string): Promise<UnreadMessageCount[]> {
    return axios
      .get<UnreadMessageCount[]>(`/users/me/teams/${teamId}/channels/members`)
      .then((response) => response.data);
  }
}
