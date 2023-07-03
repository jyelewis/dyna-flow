import { DFTable } from "./DFTable.js";
import { UpdateCommandInput, DeleteCommandInput } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { WriteTransactionFailedError } from "./errors/WriteTransactionFailedError.js";
import { DynamoItem, DynamoValue, RETRY_TRANSACTION } from "./types/types.js";
import {
  DFConditionCheckOperation,
  DFDeleteOperation,
  DFUpdateOperation,
  DFWritePrimaryOperation,
  DFWriteSecondaryOperation,
} from "./types/operations.js";
import assert from "assert";
import { conditionToConditionExpression } from "./utils/conditionToConditionExpression.js";
import { isDynamoValue } from "./utils/isDynamoValue.js";
import { DFConditionalCheckFailedException } from "./errors/DFConditionalCheckFailedException.js";

const MAX_TRANSACTION_RETRIES = 5;

// have to re-declare as the dynamo client doesn't export this type for us to build upon
interface ConditionCheckCommandInput {
  Key: Record<string, DynamoValue>;
  TableName: string;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, DynamoValue>;
}

export class DFWriteTransaction {
  // potential future problem
  // a single key cannot have multiple transaction items operate against it at once
  // could have to merge ops in future if they interact with the same item...
  // Maybe that's a cleaner way to add meta properties to objects anyway though? idk
  private retryCount = 0;
  public readonly secondaryOperations: DFWriteSecondaryOperation[] = [];
  public readonly preCommitHandlers: Array<() => Promise<void>> = [];
  public resultTransformer?: (
    item: DynamoItem
  ) => Promise<DynamoItem> | DynamoItem;

  public constructor(
    public table: DFTable,
    public primaryOperation: DFWritePrimaryOperation
  ) {}

  public get primaryUpdateOperation(): DFUpdateOperation {
    // TODO: test me
    assert(this.primaryOperation.type === "Update");
    return this.primaryOperation as DFUpdateOperation;
  }

  public addSecondaryOperation(op: DFWriteSecondaryOperation) {
    // or even take a callback to handle an error
    this.secondaryOperations.push(op);
  }

  public addSecondaryTransaction(secondaryTransaction: DFWriteTransaction) {
    this.secondaryOperations.push(secondaryTransaction.primaryOperation);
    this.secondaryOperations.push(...secondaryTransaction.secondaryOperations);
    // TODO: test me
    this.preCommitHandlers.push(...secondaryTransaction.preCommitHandlers);
    // leave their resultTransformer behind, only needed for the primary item
  }

  public addPreCommitHandler(handlerFn: () => Promise<void>) {
    // pre-commit handlers will run right before the commit
    // allowing read-before-write operations
    // if the commit fails and is re-tried, the pre-commit handler will be run again
    this.preCommitHandlers.push(handlerFn);
  }

  public async commit(): Promise<DynamoItem | null> {
    await Promise.all(this.preCommitHandlers.map((x) => x()));

    if (this.secondaryOperations.length === 0) {
      try {
        // executeSingle always returns the full item from primaryOperation
        // if we are doing a write operation
        // types were too annoying to express
        const item = await this.executeSingle();

        if (
          this.primaryOperation.type === "Update" &&
          this.primaryOperation.successHandlers
        ) {
          assert(item);
          await Promise.all(
            this.primaryOperation.successHandlers.map((handler) =>
              handler(item)
            )
          );
        }

        // call the provided transform function (if any) on the raw row before we return it
        return item && this.resultTransformer
          ? await this.resultTransformer(item)
          : item;
      } catch (e: any) {
        // make Dynamo errors consistent with multi-op error handling
        let userFacingError = e;
        if (e.name === "ConditionalCheckFailedException") {
          userFacingError = new DFConditionalCheckFailedException();
        }

        if (!this.primaryOperation.errorHandler) {
          throw userFacingError;
        }

        const errorHandlerResponse = await this.primaryOperation.errorHandler(
          userFacingError,
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore: intentionally didn't want to type PrimaryOperation down to the op type - too much complexity
          this.primaryOperation
        );

        switch (errorHandlerResponse) {
          case RETRY_TRANSACTION: {
            if (this.retryCount >= MAX_TRANSACTION_RETRIES) {
              throw new WriteTransactionFailedError("Max retries exceeded");
            }
            this.retryCount += 1;

            return this.commit();
          }
          default:
            throw new Error(
              "Transaction operation error handler returned invalid response. Error handlers must throw an error themselves, or return RETRY_TRANSACTION"
            );
        }
      }
    }

    try {
      await this.executeMany();
    } catch (e: any) {
      /* istanbul ignore next */
      if (!(e instanceof TransactionCanceledException)) {
        throw e;
      }

      /* istanbul ignore next */
      if (!e.CancellationReasons) {
        throw new WriteTransactionFailedError(
          `Transaction failed, but no CancellationReasons were provided: ${e}`
        );
      }

      for (const [index, reason] of e.CancellationReasons.entries()) {
        if (reason.Code === "None") {
          continue; // no errors here
        }

        // make errors consistent between multi and single transactions
        let userFacingError: any = reason;
        if (reason.Code === "ConditionalCheckFailedException") {
          // TODO: test me :)
          userFacingError = new DFConditionalCheckFailedException();
        }

        const op =
          index === 0
            ? this.primaryOperation
            : this.secondaryOperations[index - 1];

        if (op.errorHandler) {
          const errorHandlerResponse = op.errorHandler(
            userFacingError,
            op as any
          );

          switch (errorHandlerResponse) {
            case RETRY_TRANSACTION: {
              if (this.retryCount >= MAX_TRANSACTION_RETRIES) {
                throw new WriteTransactionFailedError("Max retries exceeded");
              }
              this.retryCount += 1;

              return this.commit();
            }
            default:
              throw new Error(
                "Transaction operation error handler returned invalid response. Error handlers must throw an error themselves, or return RETRY_TRANSACTION"
              );
          }
        }
      }

      // we'd generally expect an errorHandler to exist, but it's possible to add an operation that can fail with no handler
      throw new WriteTransactionFailedError(e);
    }

    // everything below here is to support onSuccess handlers & return value

    // kind of annoying, but we need to fetch the entity(s) after the transaction completes
    // transactions don't support returning the updated item
    const updateOpsNeededForFetch: Array<{
      index: number;
      handlers: Array<(item: DynamoItem) => void | Promise<void>>;
    }> = [];
    let primaryOperationReturnValue: DynamoItem | null = null;

    if (this.primaryOperation.type === "Update") {
      updateOpsNeededForFetch.push({
        index: 0,
        // we always need to fetch the primary operation back if it's a write
        // it's required for the return value of this function
        handlers: this.primaryOperation.successHandlers || [],
      });
    }

    for (const [index, op] of this.secondaryOperations.entries()) {
      if (
        op.type === "Update" &&
        op.successHandlers !== undefined &&
        op.successHandlers.length > 0
      ) {
        updateOpsNeededForFetch.push({
          index: index + 1,
          handlers: op.successHandlers,
        });
      }
    }

    await Promise.all(
      updateOpsNeededForFetch.map(async ({ index, handlers }) => {
        const op =
          index === 0
            ? this.primaryOperation
            : this.secondaryOperations[index - 1];

        const res = await this.table.client.get({
          TableName: this.table.tableName,
          Key: op.key,
          // want to grab a consistent read so we are sure to read at least past our write
          ConsistentRead: true,
        });

        /* istanbul ignore next */
        if (res.Item === undefined) {
          // must have been deleted between write and read?
          // not much we can do here, and success handlers aren't 'guaranteed' to be called
          console.warn(
            "Unable to call transaction success handler, item deleted"
          );
          return;
        }

        if (index === 0) {
          // this is the primary item, keep a copy of the value so we can return it later
          primaryOperationReturnValue = res.Item as DynamoItem;
        }

        await Promise.all(handlers.map((handler) => handler(res.Item as any)));
      })
    );

    // call the provided transform function (if any) on the raw row before we return it
    return primaryOperationReturnValue && this.resultTransformer
      ? await this.resultTransformer(primaryOperationReturnValue)
      : primaryOperationReturnValue;
  }

  public async commitWithReturn(): Promise<DynamoItem> {
    // typescript wrapper
    if (this.primaryOperation.type !== "Update") {
      throw new Error(
        "Cannot call commitWithReturn() on a transaction with no primary operation of type 'Update'"
      );
    }

    return (await this.commit()) as DynamoItem;
  }

  private async executeSingle(): Promise<DynamoItem | null> {
    const op = this.primaryOperation;

    switch (op.type) {
      case "Update": {
        const updateRes = await this.table.client.update(
          this.updateExpressionToParams(op)
        );
        return updateRes.Attributes as DynamoItem;
      }
      case "Delete": {
        await this.table.client.delete(this.deleteExpressionToParams(op));
        return null;
      }
      default:
        throw new Error(`Unknown operation type`);
    }
  }

  private async executeMany(): Promise<void> {
    const ops = [this.primaryOperation, ...this.secondaryOperations];
    const transactionItems: any[] = [];
    for (const op of ops) {
      switch (op.type) {
        case "Update":
          transactionItems.push({
            Update: this.updateExpressionToParams(op),
          });
          continue;
        case "Delete":
          transactionItems.push({
            Delete: this.deleteExpressionToParams(op),
          });
          continue;
        case "ConditionCheck":
          transactionItems.push({
            ConditionCheck: this.conditionCheckExpressionToParams(op),
          });
          continue;
        default:
          throw new Error(`Unknown operation type`);
      }
    }

    await this.table.client.transactWrite({
      TransactItems: transactionItems,
    });
  }

  // TODO: should this become a util function and be tested like the others (check expected output + execute)
  private updateExpressionToParams(op: DFUpdateOperation): UpdateCommandInput {
    const expressionAttributeNames: Record<string, any> = {};
    const expressionAttributeValues: Record<string, any> = {};

    // generate an update expression & add the values to the expressionAttributes
    const operations: {
      SET: string[];
      ADD: string[];
      REMOVE: string[];
      DELETE: string[];
    } = {
      SET: [],
      ADD: [],
      REMOVE: [],
      DELETE: [],
    };
    let index = 0;
    Object.keys(op.updateValues).forEach((key) => {
      // process keys into a format we can use in the expression
      // this is mostly for dot or array notation for updating sub items

      // [0] is not a valid expression on its own, index lookups must be part of a larger expression
      if (key.startsWith("[")) {
        throw new Error("Invalid key, cannot start index lookup");
      }
      const keyAttributeParts: string[] = [];
      key.split(/[.[]/g).forEach((subKey) => {
        if (subKey.endsWith("]")) {
          // index notation [1] - extract integer
          const indexValue = parseInt(subKey.replace("]", ""), 10);

          // cheaper to inline the index value into the expression string
          keyAttributeParts.push(`[${indexValue}]`);
          return;
        }

        // object property notation
        keyAttributeParts.push(`.#update_key${index}`);
        expressionAttributeNames[`#update_key${index}`] = subKey;
        index++;
      });

      // may be a complex string for nested objects
      // i.e "#update_key_0.#update_key_1[4].#update_key_2"
      // all names have already been populated in expressionAttributeNames
      // need to chop the '.' at the start from the first attribute name
      const keyAttributeStr = keyAttributeParts.join("").substring(1);

      const updateValue = op.updateValues[key];

      // literal value update
      if (isDynamoValue(updateValue)) {
        expressionAttributeValues[`:update_value${index}`] =
          op.updateValues[key];

        operations.SET.push(`${keyAttributeStr}=:update_value${index}`);
        return;
      }

      if ("$inc" in updateValue) {
        // "SET #age = if_not_exists(#age, :zero) + :inc"
        expressionAttributeValues[`:update_value${index}`] =
          updateValue["$inc"];
        expressionAttributeValues[`:zero`] = 0;

        operations.SET.push(
          `${keyAttributeStr}=if_not_exists(${keyAttributeStr}, :zero) + :update_value${index}`
        );

        return;
      }

      if ("$setIfNotExists" in updateValue) {
        // "SET #name = if_not_exists(#name, :new_value)"
        expressionAttributeValues[`:update_value${index}`] =
          updateValue["$setIfNotExists"];

        operations.SET.push(
          `${keyAttributeStr}=if_not_exists(${keyAttributeStr}, :update_value${index})`
        );

        return;
      }

      if ("$remove" in updateValue) {
        // "REMOVE #age"
        operations.REMOVE.push(`${keyAttributeStr}`);

        return;
      }

      if ("$addItemsToSet" in updateValue) {
        // "ADD #set :new_value"
        expressionAttributeValues[`:update_value${index}`] =
          updateValue["$addItemsToSet"];

        operations.ADD.push(`${keyAttributeStr} :update_value${index}`);

        return;
      }

      if ("$removeItemsFromSet" in updateValue) {
        // "DELETE #set :value"
        expressionAttributeValues[`:update_value${index}`] =
          updateValue["$removeItemsFromSet"];

        operations.DELETE.push(`${keyAttributeStr} :update_value${index}`);

        return;
      }

      if ("$appendItemsToList" in updateValue) {
        // "SET #list = list_append(#list, :new_items)"
        expressionAttributeValues[`:update_value${index}`] =
          updateValue["$appendItemsToList"];

        operations.SET.push(
          `${keyAttributeStr}=list_append(${keyAttributeStr}, :update_value${index})`
        );

        return;
      }

      throw new Error(
        `Invalid update operation: ${JSON.stringify(updateValue)}`
      );
    });

    const updateExpressions = [];
    if (operations.SET.length > 0) {
      updateExpressions.push(`SET ${operations.SET.join(", ")}`);
    }
    if (operations.ADD.length > 0) {
      updateExpressions.push(`ADD ${operations.ADD.join(", ")}`);
    }
    if (operations.REMOVE.length > 0) {
      updateExpressions.push(`REMOVE ${operations.REMOVE.join(", ")}`);
    }
    if (operations.DELETE.length > 0) {
      updateExpressions.push(`DELETE ${operations.DELETE.join(", ")}`);
    }
    const fullUpdateExpression = updateExpressions.join(" ");

    const {
      conditionExpression,
      expressionAttributeNames: conditionExpressionAttributeNames,
      expressionAttributeValues: conditionExpressionAttributeValues,
    } = conditionToConditionExpression(op.condition);

    Object.assign(expressionAttributeNames, conditionExpressionAttributeNames);
    Object.assign(
      expressionAttributeValues,
      conditionExpressionAttributeValues
    );

    return {
      TableName: this.table.tableName,
      Key: op.key,
      UpdateExpression: fullUpdateExpression,
      ConditionExpression: conditionExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };
  }

  private deleteExpressionToParams(op: DFDeleteOperation): DeleteCommandInput {
    const {
      conditionExpression,
      expressionAttributeNames,
      expressionAttributeValues,
    } = conditionToConditionExpression(op.condition);

    return {
      TableName: this.table.tableName,
      Key: op.key,
      ConditionExpression: conditionExpression!,
      ExpressionAttributeNames: expressionAttributeNames!,
      ExpressionAttributeValues: expressionAttributeValues,
    };
  }

  private conditionCheckExpressionToParams(
    op: DFConditionCheckOperation
  ): ConditionCheckCommandInput {
    const {
      conditionExpression,
      expressionAttributeNames,
      expressionAttributeValues,
    } = conditionToConditionExpression(op.condition);

    return {
      TableName: this.table.tableName,
      Key: op.key,
      ConditionExpression: conditionExpression!,
      ExpressionAttributeNames: expressionAttributeNames!,
      ExpressionAttributeValues: expressionAttributeValues,
    };
  }
}
