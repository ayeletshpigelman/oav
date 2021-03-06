// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import * as JsonRefs from "json-refs"
import * as fs from "fs"
import * as path from "path"
import * as utils from "./util/utils"
import * as Sway from "yasway"
import * as msRest from "ms-rest"

const HttpRequest = msRest.WebResource

import { log } from "./util/logging"
import { SpecResolver } from "./validators/specResolver"
import { ResponseWrapper } from "./models/responseWrapper"
import { MarkdownHttpTemplate } from "./templates/markdownHttpTemplate"
import { YamlHttpTemplate } from "./templates/yamlHttpTemplate"
import * as C from "./util/constants"
import { MutableStringMap, StringMap } from "@ts-common/string-map"
import { PathTemplateBasedRequestPrepareOptions } from "ms-rest"
import { Responses, Headers } from "./templates/httpTemplate"

const ErrorCodes = C.ErrorCodes

export class WireFormatGenerator {
  private specPath: string
  private specDir: string
  private wireFormatDir: string
  private emitYaml: unknown
  private specInJson: Sway.SwaggerObject|null
  private specResolver: SpecResolver|null
  private swaggerApi: Sway.SwaggerApi|null
  private options: { readonly shouldResolveRelativePaths: unknown }
  // private specValidationResult: any
  constructor(
    specPath: string, specInJson: Sway.SwaggerObject|null, wireFormatDir: string, emitYaml: unknown
  ) {
    if (specPath === null
      || specPath === undefined
      || typeof specPath.valueOf() !== "string"
      || !specPath.trim().length
    ) {
      throw new Error(
        "specPath is a required parameter of type string and it cannot be an empty string.")
    }
    // If the spec path is a url starting with https://github then let us auto convert it to an
    // https://raw.githubusercontent url.
    if (specPath.startsWith("https://github")) {
      specPath = specPath.replace(
        /^https:\/\/(github.com)(.*)blob\/(.*)/ig, "https://raw.githubusercontent.com$2$3")
    }
    this.specPath = specPath
    this.specDir = path.dirname(this.specPath)
    let wfDir = path.join(this.specDir, "wire-format")
    if (specPath.startsWith("https://")) {
      wfDir = process.cwd() + "/wire-format"
    }
    this.wireFormatDir = wireFormatDir || wfDir
    if (!fs.existsSync(this.wireFormatDir)) {
      fs.mkdirSync(this.wireFormatDir)
    }
    this.emitYaml = emitYaml || false
    this.specInJson = specInJson
    this.specResolver = null
    this.swaggerApi = null
    this.options = {
      shouldResolveRelativePaths: true
    }
  }

  public async initialize(): Promise<Sway.SwaggerApi> {
    if (this.options.shouldResolveRelativePaths) {
      utils.clearCache()
    }
    try {
      const result = await utils.parseJson(this.specPath)
      this.specInJson = result
      const specOptions = {
        shouldResolveRelativePaths: true,
        shouldResolveXmsExamples: false,
        shouldResolveAllOf: false,
        shouldSetAdditionalPropertiesFalse: false,
        shouldResolvePureObjects: false
      }
      this.specResolver = new SpecResolver(this.specPath, this.specInJson, specOptions)
      await this.specResolver.resolve()
      await this.resolveExamples()
      const options = {
        definition: this.specInJson,
        jsonRefs: { relativeBase: this.specDir }
      }
      const api = await Sway.create(options)
      this.swaggerApi = api
      return api
    } catch (err) {
      const e = this.constructErrorObject(ErrorCodes.ResolveSpecError, err.message, [err])
      // self.specValidationResult.resolveSpec = e;
      log.error(`${ErrorCodes.ResolveSpecError.name}: ${err.message}.`)
      log.error(err.stack)
      throw e
    }
  }

  /*
   * Generates wire-format for the given operationIds or all the operations in the spec.
   *
   * @param {string} [operationIds] - A comma separated string specifying the operations for
   * which the wire format needs to be generated. If not specified then the entire spec is
   * processed.
   */
  public processOperations(operationIds: string|null): void {
    if (!this.swaggerApi) {
      throw new Error(
        `Please call "specValidator.initialize()" before calling this method, ` +
        `so that swaggerApi is populated.`)
    }
    if (operationIds !== null
      && operationIds !== undefined
      && typeof operationIds.valueOf() !== "string") {
      throw new Error(`operationIds parameter must be of type 'string'.`)
    }

    let operations = this.swaggerApi.getOperations()
    if (operationIds) {
      const operationIdsObj: MutableStringMap<unknown> = {}
      operationIds.trim().split(",").forEach(item => { operationIdsObj[item.trim()] = 1; })
      const operationsToValidate = operations.filter(item =>
        Boolean(operationIdsObj[item.operationId]))
      if (operationsToValidate.length) { operations = operationsToValidate }
    }

    for (const operation of operations) {
      this.processOperation(operation)
    }
  }

  /*
   * Updates the validityStatus of the internal specValidationResult based on the provided value.
   *
   * @param {boolean} value A truthy or a falsy value.
   */
  /*
  private updateValidityStatus(value: boolean): void {
    if (!Boolean(value)) {
      this.specValidationResult.validityStatus = false
    } else {
      this.specValidationResult.validityStatus = true
    }
    return
  }
  */

  /*
   * Constructs the Error object and updates the validityStatus unless indicated to not update the
   * status.
   *
   * @param {string} code The Error code that uniquely identifies the error.
   *
   * @param {string} message The message that provides more information about the error.
   *
   * @param {array} [innerErrors] An array of Error objects that specify inner details.
   *
   * @param {boolean} [skipValidityStatusUpdate] When specified a truthy value it will skip updating
   *                                             the validity status.
   *
   * @return {object} err Return the constructed Error object.
   */
  private constructErrorObject(
    code: unknown, message: string, innerErrors: Array<unknown>, _?: boolean
  ) {
    const err = {
      code,
      message,
      innerErrors: undefined as (Array<unknown>|undefined)
    }
    if (innerErrors) {
      err.innerErrors = innerErrors
    }
    // if (!skipValidityStatusUpdate) {
    // this.updateValidityStatus();
    // }
    return err
  }

  private async resolveExamples(): Promise<Sway.SwaggerObject|null|ReadonlyArray<unknown>> {
    const options = {
      relativeBase: this.specDir,
      filter: ["relative", "remote"]
    }

    const allRefsRemoteRelative = JsonRefs.findRefs(this.specInJson, options)
    const promiseFactories = utils.getKeys(allRefsRemoteRelative as any).map(refName => {
      const refDetails = (allRefsRemoteRelative as any)[refName]
      return async () => await this.resolveRelativeReference(
        refName, refDetails, this.specInJson, this.specPath)
    })
    if (promiseFactories.length) {
      return await utils.executePromisesSequentially(promiseFactories)
    } else {
      return this.specInJson
    }
  }

  private async resolveRelativeReference(
    refName: string,
    refDetails: { readonly def: { readonly $ref: string } },
    doc: {}|null,
    docPath: string
  ): Promise<unknown> {

    if (!refName || (refName && typeof refName.valueOf() !== "string")) {
      throw new Error('refName cannot be null or undefined and must be of type "string".')
    }

    if (!refDetails || (refDetails && !(refDetails instanceof Object))) {
      throw new Error('refDetails cannot be null or undefined and must be of type "object".')
    }

    if (!doc || (doc && !(doc instanceof Object))) {
      throw new Error('doc cannot be null or undefined and must be of type "object".')
    }

    if (!docPath || (docPath && typeof docPath.valueOf() !== "string")) {
      throw new Error('docPath cannot be null or undefined and must be of type "string".')
    }

    const node = refDetails.def
    const slicedRefName = refName.slice(1)
    const reference = node.$ref
    const parsedReference = utils.parseReferenceInSwagger(reference)
    const docDir = path.dirname(docPath)

    if (parsedReference.filePath) {
      // assuming that everything in the spec is relative to it, let us join the spec directory
      // and the file path in reference.
      docPath = utils.joinPath(docDir, parsedReference.filePath)
    }

    const result = await utils.parseJson(docPath)
    if (!parsedReference.localReference) {
      // Since there is no local reference we will replace the key in the object with the parsed
      // json (relative) file it is referring to.
      const regex = /.*x-ms-examples.*/ig
      if (slicedRefName.match(regex) !== null) {
        const exampleObj = {
          filePath: docPath,
          value: result
        }
        utils.setObject(doc, slicedRefName, exampleObj)
      }
    }
    return doc
  }

  /*
   * Generates wireformat for the given operation.
   *
   * @param {object} operation - The operation object.
   */
  private processOperation(operation: Sway.Operation): void {
    this.processXmsExamples(operation)
    // self.processExample(operation)
  }

  /*
   * Process the x-ms-examples object for an operation if specified in the swagger spec.
   *
   * @param {object} operation - The operation object.
   */
  private processXmsExamples(operation: Sway.Operation): void {
    if (operation === null || operation === undefined || typeof operation !== "object") {
      throw new Error("operation cannot be null or undefined and must be of type 'object'.")
    }
    const xmsExamples = operation[C.xmsExamples]
    if (xmsExamples) {
      for (const scenario of utils.getKeys(xmsExamples)) {
        // If we do not see the value property then we assume that the swagger spec had
        // x-ms-examples references resolved.
        // Then we do not need to access the value property. At the same time the file name for
        // wire-format will be the sanitized scenario name.
        const xmsExample = xmsExamples[scenario].value || xmsExamples[scenario]
        const sampleRequest = this.processRequest(operation, xmsExample.parameters)
        const sampleResponses = this.processXmsExampleResponses(operation, xmsExample.responses)
        const exampleFileName = xmsExamples[scenario].filePath
          ? path.basename(xmsExamples[scenario].filePath)
          : `${utils.sanitizeFileName(scenario)}.json`
        let wireFormatFileName =
          `${exampleFileName.substring(0, exampleFileName.indexOf(path.extname(exampleFileName)))}.`
        wireFormatFileName += this.emitYaml ? "yml" : "md"
        const fileName = path.join(this.wireFormatDir, wireFormatFileName)
        const httpTemplate = this.emitYaml
          ? new YamlHttpTemplate(sampleRequest, sampleResponses)
          : new MarkdownHttpTemplate(sampleRequest, sampleResponses)
        const sampleData = httpTemplate.populate()
        fs.writeFileSync(fileName, sampleData, { encoding: "utf8" })
      }
    }
  }

  /*
   * Processes the request for an operation to generate in wire format.
   *
   * @param {object} operation - The operation object.
   *
   * @param {object} exampleParameterValues - The example parameter values.
   *
   * @return {object} result - The validation result.
   */
  private processRequest(
    operation: Sway.Operation,
    exampleParameterValues: StringMap<string>
  ): msRest.WebResource {
    if (operation === null || operation === undefined || typeof operation !== "object") {
      throw new Error("operation cannot be null or undefined and must be of type 'object'.")
    }

    if (exampleParameterValues === null
      || exampleParameterValues === undefined
      || typeof exampleParameterValues !== "object") {
      throw new Error(
        `In operation "${operation.operationId}", exampleParameterValues cannot be null or ` +
        `undefined and must be of type "object" ` +
        `(A dictionary of key-value pairs of parameter-names and their values).`)
    }

    const parameters = operation.getParameters()

    let pathTemplate = operation.pathObject.path
    if (pathTemplate && pathTemplate.includes("?")) {
      pathTemplate = pathTemplate.slice(0, pathTemplate.indexOf("?"))
      operation.pathObject.path = pathTemplate
    }
    const options = {
      method: operation.method,
      pathTemplate
    } as PathTemplateBasedRequestPrepareOptions

    for (const parameter of parameters) {
      const location = parameter.in
      if (location === "path" || location === "query") {
        const paramType = location + "Parameters"
        const optionsParameters = options as any as MutableStringMap<MutableStringMap<unknown>>
        if (!optionsParameters[paramType]) { optionsParameters[paramType] = {} }
        if (parameter[C.xmsSkipUrlEncoding]
          || utils.isUrlEncoded(exampleParameterValues[parameter.name])) {
            optionsParameters[paramType][parameter.name] = {
            value: exampleParameterValues[parameter.name],
            skipUrlEncoding: true
          }
        } else {
          optionsParameters[paramType][parameter.name] = exampleParameterValues[parameter.name]
        }
      } else if (location === "body") {
        options.body = exampleParameterValues[parameter.name]
        options.disableJsonStringifyOnBody = true
      } else if (location === "header") {
        if (!options.headers) { options.headers = {} }
        options.headers[parameter.name] = exampleParameterValues[parameter.name]
      }
    }

    if (options.headers) {
      if (options.headers["content-type"]) {
        const val = delete options.headers["content-type"]
        options.headers["Content-Type"] = val
      }
      if (!options.headers["Content-Type"]) {
        options.headers["Content-Type"] = utils.getJsonContentType(operation.consumes)
      }
    } else {
      options.headers = {}
      options.headers["Content-Type"] = utils.getJsonContentType(operation.consumes)
    }
    return new HttpRequest().prepare(options)
  }

  /*
   * Validates the responses given in x-ms-examples object for an operation.
   *
   * @param {object} operation - The operation object.
   *
   * @param {object} exampleResponseValue - The example response value.
   *
   * @return {object} result - The validation result.
   */
  private processXmsExampleResponses(
    operation: Sway.Operation,
    exampleResponseValue: StringMap<{
      readonly headers: Headers
      readonly body: unknown
    }>
  ) {
    const result = {} as Responses
    if (operation === null || operation === undefined || typeof operation !== "object") {
      throw new Error("operation cannot be null or undefined and must be of type 'object'.")
    }

    if (exampleResponseValue === null
      || exampleResponseValue === undefined
      || typeof exampleResponseValue !== "object") {
      throw new Error("operation cannot be null or undefined and must be of type 'object'.")
    }
    const responsesInSwagger: MutableStringMap<string> = {}
    operation.getResponses().map(response => {
      responsesInSwagger[response.statusCode] = response.statusCode
      return response.statusCode
    })
    const xMsLongRunningOperation = operation["x-ms-long-running-operation"]
    if (xMsLongRunningOperation) {
      result.longrunning = { initialResponse: undefined, finalResponse: undefined }
    } else {
      result.standard = { finalResponse: undefined }
    }

    for (const exampleResponseStatusCode of utils.getKeys(exampleResponseValue)) {
      const response = operation.getResponse(exampleResponseStatusCode)
      if (response) {
        const exampleResponseHeaders =
          exampleResponseValue[exampleResponseStatusCode].headers || {}
        const exampleResponseBody = exampleResponseValue[exampleResponseStatusCode].body
        // ensure content-type header is present
        if (!(exampleResponseHeaders["content-type"] || exampleResponseHeaders["Content-Type"])) {
          exampleResponseHeaders["content-type"] = utils.getJsonContentType(operation.produces)
        }
        const exampleResponse = new ResponseWrapper(
          exampleResponseStatusCode, exampleResponseBody, exampleResponseHeaders
        )
        if (xMsLongRunningOperation) {
          if (result.longrunning === undefined) {
            throw new Error("result.longrunning === undefined")
          }
          if (exampleResponseStatusCode === "202" || exampleResponseStatusCode === "201") {
            result.longrunning.initialResponse = exampleResponse
          }
          if ((exampleResponseStatusCode === "200" || exampleResponseStatusCode === "204")
            && !result.longrunning.finalResponse) {
            result.longrunning.finalResponse = exampleResponse
          }
        } else {
          if (result.standard === undefined) {
            throw new Error("result.standard === undefined")
          }
          if (!result.standard.finalResponse) { result.standard.finalResponse = exampleResponse }
        }
      }
    }
    return result
  }

}
