import _ from "lodash";
import * as db from "./db";
import { ObjectId } from "mongodb";
import Logger from "../utils/logger";
import { identity } from "../utils/misc";
import { BASE_CONFIGURATION } from "../constants/base-configuration";
import { Configuration } from "@monkeytype/shared-types";
import { addLog } from "../dal/logs";

const CONFIG_UPDATE_INTERVAL = 10 * 60 * 1000; // 10 Minutes

function mergeConfigurations(
  baseConfiguration: Configuration,
  liveConfiguration: Partial<Configuration>
): void {
  if (
    !_.isPlainObject(baseConfiguration) ||
    !_.isPlainObject(liveConfiguration)
  ) {
    return;
  }

  function merge(base: object, source: object): void {
    const commonKeys = _.intersection(_.keys(base), _.keys(source));

    commonKeys.forEach((key) => {
      const baseValue = base[key];
      const sourceValue = source[key];

      const isBaseValueObject = _.isPlainObject(baseValue);
      const isSourceValueObject = _.isPlainObject(sourceValue);

      if (isBaseValueObject && isSourceValueObject) {
        merge(baseValue, sourceValue);
      } else if (identity(baseValue) === identity(sourceValue)) {
        base[key] = sourceValue;
      }
    });
  }

  merge(baseConfiguration, liveConfiguration);
}

let configuration = BASE_CONFIGURATION;
let lastFetchTime = 0;
let serverConfigurationUpdated = false;

export async function getCachedConfiguration(
  attemptCacheUpdate = false
): Promise<Configuration> {
  if (
    attemptCacheUpdate &&
    lastFetchTime < Date.now() - CONFIG_UPDATE_INTERVAL
  ) {
    Logger.info("Cached configuration is stale.");
    return await getLiveConfiguration();
  }

  return configuration;
}

export async function getLiveConfiguration(): Promise<Configuration> {
  lastFetchTime = Date.now();

  const configurationCollection = db.collection("configuration");

  try {
    const liveConfiguration = await configurationCollection.findOne();

    if (liveConfiguration) {
      const baseConfiguration = _.cloneDeep(BASE_CONFIGURATION);

      const liveConfigurationWithoutId = _.omit(
        liveConfiguration,
        "_id"
      ) as Configuration;
      mergeConfigurations(baseConfiguration, liveConfigurationWithoutId);

      await pushConfiguration(baseConfiguration);
      configuration = baseConfiguration;
    } else {
      await configurationCollection.insertOne({
        ...BASE_CONFIGURATION,
        _id: new ObjectId(),
      }); // Seed the base configuration.
    }
  } catch (error) {
    void addLog(
      "fetch_configuration_failure",
      `Could not fetch configuration: ${error.message}`
    );
  }

  return configuration;
}

async function pushConfiguration(configuration: Configuration): Promise<void> {
  if (serverConfigurationUpdated) {
    return;
  }

  try {
    await db.collection("configuration").replaceOne({}, configuration);
    serverConfigurationUpdated = true;
  } catch (error) {
    void addLog(
      "push_configuration_failure",
      `Could not push configuration: ${error.message}`
    );
  }
}

export async function patchConfiguration(
  configurationUpdates: Partial<Configuration>
): Promise<boolean> {
  try {
    const currentConfiguration = _.cloneDeep(configuration);
    mergeConfigurations(currentConfiguration, configurationUpdates);

    await db
      .collection("configuration")
      .updateOne({}, { $set: currentConfiguration }, { upsert: true });

    await getLiveConfiguration();
  } catch (error) {
    void addLog(
      "patch_configuration_failure",
      `Could not patch configuration: ${error.message}`
    );

    return false;
  }

  return true;
}
