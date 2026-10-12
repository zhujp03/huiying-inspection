// COS 续期配置可达性回归：Zod 不得剥离 AssumeRole/续期字段。
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";
import { createCosCredentialProvider } from "../../apps/api/src/storage/cos.js";

describe("COS renewal config reachability", () => {
  it("loadConfig retains the AssumeRole and renewal fields (not stripped by Zod)", () => {
    const env = {
      NODE_ENV: "development",
      COS_REGION: "ap-shanghai",
      COS_ROLE_ARN: "qcs::cam::uin/10001:roleName/junde-cos",
      COS_ASSUME_ROLE_SECRET_ID: "AKID_ASSUME",
      COS_ASSUME_ROLE_SECRET_KEY: "assume-secret",
      COS_STS_DURATION_SECONDS: "3600",
      COS_STS_REFRESH_BEFORE_SECONDS: "300",
      COS_STS_TIMEOUT_MS: "8000",
    };
    const config = loadConfig(env);
    expect(config.COS_ASSUME_ROLE_SECRET_ID).toBe("AKID_ASSUME");
    expect(config.COS_ASSUME_ROLE_SECRET_KEY).toBe("assume-secret");
    expect(config.COS_STS_DURATION_SECONDS).toBe(3600);
    expect(config.COS_STS_REFRESH_BEFORE_SECONDS).toBe(300);
    expect(config.COS_STS_TIMEOUT_MS).toBe(8000);
    // 续期 Provider 能从解析后的配置直接构造（renewing 模式可达）。
    const provider = createCosCredentialProvider(config);
    expect(provider.mode).toBe("renewing");
  });

  it("static STS is only reachable when explicitly configured", () => {
    const config = loadConfig({ NODE_ENV: "test", COS_STS_SECRET_ID: "s", COS_STS_SECRET_KEY: "k", COS_STS_TOKEN: "t", COS_STS_EXPIRES_AT: "2026-01-01T00:00:00Z" });
    expect(createCosCredentialProvider(config).mode).toBe("static");
  });
});
