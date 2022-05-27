import toChildrenArray from 'rc-util/lib/Children/toArray';
import warning from 'rc-util/lib/warning';
import * as React from 'react';
import type {
  FieldEntity,
  FormInstance,
  InternalNamePath,
  Meta,
  NamePath,
  NotifyInfo,
  Rule,
  Store,
  ValidateOptions,
  InternalFormInstance,
  RuleObject,
  StoreValue,
  EventArgs,
  RuleError,
} from './interface';
import FieldContext, { HOOK_MARK } from './FieldContext';
import { toArray } from './utils/typeUtil';
import { validateRules } from './utils/validateUtil';
import {
  containsNamePath,
  defaultGetValueFromEvent,
  getNamePath,
  getValue,
} from './utils/valueUtil';

const EMPTY_ERRORS: any[] = [];

export type ShouldUpdate<Values = any> =
  | boolean
  | ((prevValues: Values, nextValues: Values, info: { source?: string }) => boolean);

function requireUpdate(
  shouldUpdate: ShouldUpdate,
  prev: StoreValue,
  next: StoreValue,
  prevValue: StoreValue,
  nextValue: StoreValue,
  info: NotifyInfo,
): boolean {
  if (typeof shouldUpdate === 'function') {
    return shouldUpdate(prev, next, 'source' in info ? { source: info.source } : {});
  }
  return prevValue !== nextValue;
}

// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
interface ChildProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [name: string]: any;
}

export interface InternalFieldProps<Values = any> {
  children?:
    | React.ReactElement
    | ((control: ChildProps, meta: Meta, form: FormInstance<Values>) => React.ReactNode);
  /**
   * Set up `dependencies` field.
   * When dependencies field update and current field is touched,
   * will trigger validate rules and render.
   */
  dependencies?: NamePath[]; // 抽象类规定实现
  getValueFromEvent?: (...args: EventArgs) => StoreValue;
  name?: InternalNamePath; // 抽象类规定实现
  normalize?: (value: StoreValue, prevValue: StoreValue, allValues: Store) => StoreValue;
  rules?: Rule[]; // 抽象类规定实现
  shouldUpdate?: ShouldUpdate<Values>;
  trigger?: string;
  validateTrigger?: string | string[] | false;
  validateFirst?: boolean | 'parallel';
  valuePropName?: string;
  getValueProps?: (value: StoreValue) => Record<string, unknown>;
  messageVariables?: Record<string, string>;
  initialValue?: any; // 抽象类规定实现
  onReset?: () => void;
  onMetaChange?: (meta: Meta & { destroy?: boolean }) => void;
  preserve?: boolean;

  /** @private Passed by Form.List props. Do not use since it will break by path check. */
  isListField?: boolean;

  /** @private Passed by Form.List props. Do not use since it will break by path check. */
  isList?: boolean;

  /** @private Pass context as prop instead of context api
   *  since class component can not get context in constructor */
  fieldContext?: InternalFormInstance;
}

export interface FieldProps<Values = any>
  extends Omit<InternalFieldProps<Values>, 'name' | 'fieldContext'> {
  name?: NamePath;
}

export interface FieldState {
  resetCount: number;
}

// We use Class instead of Hooks here since it will cost much code by using Hooks.
// Field组件 是 抽象类FieldEntity 的实现
class Field extends React.Component<InternalFieldProps, FieldState> implements FieldEntity {
  public static contextType = FieldContext;

  public static defaultProps = {
    trigger: 'onChange',
    valuePropName: 'value',
  }; // 默认属性  trigger onChange valuePropsName 'value' 
  //  Class 组件的 defaultProps 可以从this.props中获取
  // 特殊的 例如checkbox 需要进行修改

  public state = {
    resetCount: 0,
  }; // TODO: 本地状态resetCount 干嘛的?   刷新组件的  通过调用SetState 刷新组件

  private cancelRegisterFunc: (
    isListField?: boolean,
    preserve?: boolean,
    namePath?: InternalNamePath,
  ) => void | null = null; // TODO: 看起来像从Form进来的

  private mounted = false; // 几个状态 

  /**
   * Follow state should not management in State since it will async update by React.
   * This makes first render of form can not get correct state value.
   */
  private touched: boolean = false; // 

  /**
   * Mark when touched & validated. Currently only used for `dependencies`.
   * Note that we do not think field with `initialValue` is dirty
   * but this will be by `isFieldDirty` func.
   */
  private dirty: boolean = false;

  private validatePromise: Promise<string[]> | null = null;

  private prevValidating: boolean;

  private errors: string[] = EMPTY_ERRORS; // 校验错误信息
  private warnings: string[] = EMPTY_ERRORS; // 校验waring信息

  // ============================== Subscriptions ==============================
  constructor(props: InternalFieldProps) {
    // 构造函数
    super(props);

    // Register on init  如果props.fieldContext 存在 进行init操作 
    // wrapperField 已经将外层的context 消费 并通过props 传递进来
    if (props.fieldContext) {
      const { getInternalHooks }: InternalFormInstance = props.fieldContext;
      const { initEntityValue } = getInternalHooks(HOOK_MARK);
      initEntityValue(this);
    }
  }

  public componentDidMount() {
    const { shouldUpdate, fieldContext } = this.props; 

    this.mounted = true; // 标志位 进行此处 mount true

    // Register on init
    if (fieldContext) {
      const { getInternalHooks }: InternalFormInstance = fieldContext;
      const { registerField } = getInternalHooks(HOOK_MARK);
      this.cancelRegisterFunc = registerField(this); // 得到了cancelRegisterFuc 函数
    }

    // One more render for component in case fields not ready
    if (shouldUpdate === true) {
      this.reRender(); // 重新force渲染,如果Field还没mount 不执行
    }
  }

  public componentWillUnmount() { // 组件删除时
    this.cancelRegister(); // 
    this.triggerMetaEvent(true);
    this.mounted = false;
  }

  public cancelRegister = () => {
    const { preserve, isListField, name } = this.props;

    if (this.cancelRegisterFunc) {
      this.cancelRegisterFunc(isListField, preserve, getNamePath(name)); //TODO: 涉及到List Field  暂时不看
    }
    this.cancelRegisterFunc = null;
  };

  // ================================== Utils ==================================
  public getNamePath = (): InternalNamePath => {
    const { name, fieldContext } = this.props;
    const { prefixName = [] }: InternalFormInstance = fieldContext;
    // 获取 Field 路径 , name的类型 是可以解构的 
    // export type InternalNamePath = (string | number)[];
    return name !== undefined ? [...prefixName, ...name] : [];
  };

  public getRules = (): RuleObject[] => {
    const { rules = [], fieldContext } = this.props;
    // rules []
    // type Rule = RuleConfig | ((form: FormInstance) => RuleConfig);
    return rules.map((rule: Rule): RuleObject => {
      if (typeof rule === 'function') {
        // fieldContext 就是 formInstance
        return rule(fieldContext);
      }
      return rule;
    });
  };

  public reRender() {
    if (!this.mounted) return; // Field ComponentDidMount 还没有执行 不执行forceUpdate
    this.forceUpdate();
  }

  public refresh = () => {
    if (!this.mounted) return; // Field ComponentDidMount 还没有执行 不重新渲染组件

    /**
     * Clean up current node.
     */
    this.setState(({ resetCount }) => ({
      resetCount: resetCount + 1,
    }));
  };

  // TODO: 
  public triggerMetaEvent = (destroy?: boolean) => {
    const { onMetaChange } = this.props;
    // TODO: 这个onMetaChange 目前看不出来什么作用  
    // onMetaChange 通过Field 组件 的props 传入  , 从外界过来的  具体作用待研究
    
    onMetaChange?.({ ...this.getMeta(), destroy });
  };

  // ========================= Field Entity Interfaces =========================
  // Trigger by store update. Check if need update the component
  // onStoreChange 实现  
  public onStoreChange: FieldEntity['onStoreChange'] = (prevStore, namePathList, info) => {
    const { shouldUpdate, dependencies = [], onReset } = this.props; //
    const { store } = info;
    const namePath = this.getNamePath();
    const prevValue = this.getValue(prevStore);
    const curValue = this.getValue(store);

    const namePathMatch = namePathList && containsNamePath(namePathList, namePath);

    // `setFieldsValue` is a quick access to update related status
    if (info.type === 'valueUpdate' && info.source === 'external' && prevValue !== curValue) {
      this.touched = true;
      this.dirty = true;
      this.validatePromise = null;
      this.errors = EMPTY_ERRORS;
      this.warnings = EMPTY_ERRORS;
      this.triggerMetaEvent();
    }

    switch (info.type) {
      case 'reset':
        if (!namePathList || namePathMatch) {
          // Clean up state
          this.touched = false;
          this.dirty = false;
          this.validatePromise = null;
          this.errors = EMPTY_ERRORS;
          this.warnings = EMPTY_ERRORS;
          this.triggerMetaEvent();

          onReset?.();

          this.refresh();
          return;
        }
        break;

      /**
       * In case field with `preserve = false` nest deps like:
       * - A = 1 => show B
       * - B = 1 => show C
       * - Reset A, need clean B, C
       */
      case 'remove': {
        if (shouldUpdate) {
          this.reRender();
          return;
        }
        break;
      }

      case 'setField': {
        if (namePathMatch) {
          const { data } = info;

          if ('touched' in data) {
            this.touched = data.touched;
          }
          if ('validating' in data && !('originRCField' in data)) {
            this.validatePromise = data.validating ? Promise.resolve([]) : null;
          }
          if ('errors' in data) {
            this.errors = data.errors || EMPTY_ERRORS;
          }
          if ('warnings' in data) {
            this.warnings = data.warnings || EMPTY_ERRORS;
          }
          this.dirty = true;

          this.triggerMetaEvent();

          this.reRender();
          return;
        }

        // Handle update by `setField` with `shouldUpdate`
        if (
          shouldUpdate &&
          !namePath.length &&
          requireUpdate(shouldUpdate, prevStore, store, prevValue, curValue, info)
        ) {
          this.reRender();
          return;
        }
        break;
      }

      case 'dependenciesUpdate': {
        /**
         * Trigger when marked `dependencies` updated. Related fields will all update
         */
        const dependencyList = dependencies.map(getNamePath);
        // No need for `namePathMath` check and `shouldUpdate` check, since `valueUpdate` will be
        // emitted earlier and they will work there
        // If set it may cause unnecessary twice rerendering
        if (dependencyList.some(dependency => containsNamePath(info.relatedFields, dependency))) {
          this.reRender();
          return;
        }
        break;
      }

      default:
        // 1. If `namePath` exists in `namePathList`, means it's related value and should update
        //      For example <List name="list"><Field name={['list', 0]}></List>
        //      If `namePathList` is [['list']] (List value update), Field should be updated
        //      If `namePathList` is [['list', 0]] (Field value update), List shouldn't be updated
        // 2.
        //   2.1 If `dependencies` is set, `name` is not set and `shouldUpdate` is not set,
        //       don't use `shouldUpdate`. `dependencies` is view as a shortcut if `shouldUpdate`
        //       is not provided
        //   2.2 If `shouldUpdate` provided, use customize logic to update the field
        //       else to check if value changed
        if (
          namePathMatch ||
          ((!dependencies.length || namePath.length || shouldUpdate) &&
            requireUpdate(shouldUpdate, prevStore, store, prevValue, curValue, info))
        ) {
          this.reRender();
          return;
        }
        break;
    }

    if (shouldUpdate === true) {
      // 兜底  shouldUpdate 为 true  只要Store 发生变化 Field组件就会重新刷新
      this.reRender();
    }
  };

  public validateRules = (options?: ValidateOptions): Promise<RuleError[]> => {
    // We should fixed namePath & value to avoid developer change then by form function
    const namePath = this.getNamePath(); // 字段路径
    const currentValue = this.getValue(); // 当前 Field 值

    // Force change to async to avoid rule OOD under renderProps field
    // TODO:  做了一个Promise.resolve()的操作  控制执行时机 renderProps
    const rootPromise = Promise.resolve().then(() => {
      if (!this.mounted) {
        return [];
      }

      const { validateFirst = false, messageVariables } = this.props;
      const { triggerName } = (options || {}) as ValidateOptions;

      let filteredRules = this.getRules();
      if (triggerName) {
        filteredRules = filteredRules.filter((rule: RuleObject) => {
          const { validateTrigger } = rule;
          if (!validateTrigger) {
            return true;
          }
          const triggerList = toArray(validateTrigger);
          return triggerList.includes(triggerName);
        });
      }

      const promise = validateRules(
        namePath,
        currentValue,
        filteredRules,
        options,
        validateFirst,
        messageVariables,
      );

      promise
        .catch(e => e)
        .then((ruleErrors: RuleError[] = EMPTY_ERRORS) => {
          if (this.validatePromise === rootPromise) {
            this.validatePromise = null;

            // Get errors & warnings
            const nextErrors: string[] = [];
            const nextWarnings: string[] = [];
            ruleErrors.forEach(({ rule: { warningOnly }, errors = EMPTY_ERRORS }) => {
              if (warningOnly) {
                nextWarnings.push(...errors);
              } else {
                nextErrors.push(...errors);
              }
            });

            this.errors = nextErrors;
            this.warnings = nextWarnings;
            this.triggerMetaEvent();

            this.reRender();
          }
        });

      return promise;
    });

    this.validatePromise = rootPromise;
    this.dirty = true;
    this.errors = EMPTY_ERRORS;
    this.warnings = EMPTY_ERRORS;
    this.triggerMetaEvent();

    // Force trigger re-render since we need sync renderProps with new meta
    this.reRender();

    return rootPromise;
  };

  public isFieldValidating = () => !!this.validatePromise;

  public isFieldTouched = () => this.touched;

  public isFieldDirty = () => {
    // Touched or validate or has initialValue
    if (this.dirty || this.props.initialValue !== undefined) {
      return true;
    }

    // Form set initialValue
    const { fieldContext } = this.props;
    const { getInitialValue } = fieldContext.getInternalHooks(HOOK_MARK);
    if (getInitialValue(this.getNamePath()) !== undefined) {
      return true;
    }

    return false;
  };

  public getErrors = () => this.errors;

  public getWarnings = () => this.warnings;

  public isListField = () => this.props.isListField;

  public isList = () => this.props.isList;

  public isPreserve = () => this.props.preserve;

  // ============================= Child Component =============================
  public getMeta = (): Meta => {
    // meta 数据 关于Field的状态
    // Make error & validating in cache to save perf
    this.prevValidating = this.isFieldValidating();

    const meta: Meta = {
      touched: this.isFieldTouched(),
      validating: this.prevValidating,
      errors: this.errors,
      warnings: this.warnings,
      name: this.getNamePath(),
    };

    return meta;
  };

  // Only return validate child node. If invalidate, will do nothing about field.
  public getOnlyChild = (
    children:
      | React.ReactNode
      | ((control: ChildProps, meta: Meta, context: FormInstance) => React.ReactNode),
  ): { child: React.ReactNode | null; isFunction: boolean } => {
    // Support render props
    if (typeof children === 'function') {
      const meta = this.getMeta();

      return {
        ...this.getOnlyChild(children(this.getControlled(), meta, this.props.fieldContext)),
        isFunction: true,
      };
    }

    // Filed element only
    const childList = toChildrenArray(children);
    if (childList.length !== 1 || !React.isValidElement(childList[0])) {
      return { child: childList, isFunction: false };
    }

    return { child: childList[0], isFunction: false };
  };

  // ============================== Field Control ==============================
  public getValue = (store?: Store) => {
    const { getFieldsValue }: FormInstance = this.props.fieldContext;
    const namePath = this.getNamePath();
    return getValue(store || getFieldsValue(true), namePath);
  };

  public getControlled = (childProps: ChildProps = {}) => {
    const {
      // 以下就是Field的props , 在Form.Item 的api 可以找到相关文档 
      trigger,
      validateTrigger,
      getValueFromEvent,
      normalize,
      valuePropName,
      getValueProps,
      // context 内容  { formInstance, validateTrigger }
      fieldContext,
    } = this.props;

    const mergedValidateTrigger =
      validateTrigger !== undefined ? validateTrigger : fieldContext.validateTrigger;

    const namePath = this.getNamePath();
    const { getInternalHooks, getFieldsValue }: InternalFormInstance = fieldContext;
    const { dispatch } = getInternalHooks(HOOK_MARK);
    const value = this.getValue();
    const mergedGetValueProps = getValueProps || ((val: StoreValue) => ({ [valuePropName]: val }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originTriggerFunc: any = childProps[trigger]; // 默认childProps['onChange']

    const control = {
      ...childProps,
      ...mergedGetValueProps(value), //valuePropName 默认值 'value' , {value : xxx}
    };

    // Add trigger
    control[trigger] = (...args: EventArgs) => {
      // 包装一下TriggerFunc(onChange)  执行之前 执行一些前置 内部逻辑 , 例如 设置一些meta状态
      // Mark as touched
      this.touched = true;
      this.dirty = true;

      this.triggerMetaEvent();

      let newValue: StoreValue;
      if (getValueFromEvent) {
        newValue = getValueFromEvent(...args);
      } else {
        newValue = defaultGetValueFromEvent(valuePropName, ...args);
      }

      if (normalize) {
        // 组件获取值后进行转换，再放入 Form 中
        // 为什么normalize 不可以是异步函数 https://ant.design/components/form-cn/#%E4%B8%BA%E4%BB%80%E4%B9%88-normalize-%E4%B8%8D%E8%83%BD%E6%98%AF%E5%BC%82%E6%AD%A5%E6%96%B9%E6%B3%95%EF%BC%9F
        newValue = normalize(newValue, value, getFieldsValue(true));
      }

      dispatch({
        type: 'updateValue',
        namePath,
        value: newValue,
      });

      if (originTriggerFunc) {
        originTriggerFunc(...args);
      }
    };

    // Add validateTrigger
    const validateTriggerList: string[] = toArray(mergedValidateTrigger || []);

    validateTriggerList.forEach((triggerName: string) => {
      // Wrap additional function of component, so that we can get latest value from store
      const originTrigger = control[triggerName];
      control[triggerName] = (...args: EventArgs) => {
        if (originTrigger) {
          originTrigger(...args);
        }

        // Always use latest rules
        const { rules } = this.props;
        if (rules && rules.length) {
          // We dispatch validate to root,
          // since it will update related data with other field with same name
          dispatch({
            type: 'validateField',
            namePath,
            triggerName,
          });
        }
      };
    });

    return control;
  };

  public render() {
    const { resetCount } = this.state;
    const { children } = this.props;

    const { child, isFunction } = this.getOnlyChild(children);

    // Not need to `cloneElement` since user can handle this in render function self
    // Field 子组件 几种形态
    // 1. ReactElement 
    // 2. function
    let returnChildNode: React.ReactNode;
    if (isFunction) {
      returnChildNode = child;
    } else if (React.isValidElement(child)) {
      returnChildNode = React.cloneElement(
        child as React.ReactElement,
        this.getControlled((child as React.ReactElement).props),
      );
    } else {
      warning(!child, '`children` of Field is not validate ReactElement.');
      returnChildNode = child;
    }

    return <React.Fragment key={resetCount}>{returnChildNode}</React.Fragment>;
  }
}

function WrapperField<Values = any>({ name, ...restProps }: FieldProps<Values>) {
  const fieldContext = React.useContext(FieldContext);

  const namePath = name !== undefined ? getNamePath(name) : undefined;

  let key: string = 'keep';
  if (!restProps.isListField) {
    key = `_${(namePath || []).join('_')}`;
  }

  // Warning if it's a directly list field.
  // We can still support multiple level field preserve.
  if (
    process.env.NODE_ENV !== 'production' &&
    restProps.preserve === false &&
    restProps.isListField &&
    namePath.length <= 1
  ) {
    warning(false, '`preserve` should not apply on Form.List fields.');
  }
  // fieldContext  显式 props 传递  因为Class组件的 constructor 不能使用Context api

  return <Field key={key} name={namePath} {...restProps} fieldContext={fieldContext} />;
}

export default WrapperField;
