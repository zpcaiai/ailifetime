import { DomainError } from "@ltm/core";
import { BrokerClient, type BrokerClientOptions } from "./client-integrations.js";
import { digest, object, type PhotoScoreRequest } from "./photo-score-contract.js";

export interface PhotoScorer { evaluate(request: PhotoScoreRequest): Promise<unknown>; }
/** External perception boundary. No model, fallback score, automatic retry or generation call. */
export class HttpPhotoScorer implements PhotoScorer {
  private readonly broker: BrokerClient;
  constructor(options: BrokerClientOptions) { this.broker=new BrokerClient(options); }
  async evaluate(value: PhotoScoreRequest): Promise<unknown> {
    const request=structuredClone(value);
    const {requestSha256,...payload}=request;
    if (digest(JSON.stringify(payload))!==requestSha256 || !Number.isInteger(request.targetAge) || request.targetAge<0 || request.targetAge>100) {
      throw new DomainError("VALIDATION_FAILED","photo scoring request binding is invalid");
    }
    let result: unknown;
    try { result=await this.broker.json("POST","/v1/photo-scores",request,`photo-score:${requestSha256}`,`photo-score:${requestSha256}`); }
    catch { throw new DomainError("DEPENDENCY_UNAVAILABLE","photo scorer is unavailable"); }
    const response=object(result,["schemaVersion","requestSha256","modelVersion","modelSha256","calibrationId","participants","imageScores"],"photo scorer response");
    if (!["ltm.photo-score.request.v1","ltm.photo-score.request.v2"].includes(request.schemaVersion) || response.schemaVersion!==request.schemaVersion.replace("request","response") || response.requestSha256!==requestSha256 ||
        response.modelVersion!==request.modelVersion || response.modelSha256!==request.modelSha256 || response.calibrationId!==request.calibrationId) {
      throw new DomainError("DEPENDENCY_UNAVAILABLE","photo scorer response is not bound to the requested image/model/calibration");
    }
    return result;
  }
}
