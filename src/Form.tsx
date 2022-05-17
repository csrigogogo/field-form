import * as React from 'react';
import type {
  Store,
  FormInstance,
  FieldData,
  ValidateMessages,
  Callbacks,
  InternalFormInstance,
} from './interface';
import useForm from './useForm';
import FieldContext, { HOOK_MARK } from './FieldContext';
import type { FormContextProps } from './FormContext';
import FormContext from './FormContext';
import { isSimilar } from './utils/valueUtil';

type BaseFormProps = Omit<React.FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'children'>;

type RenderProps = (values: Store, form: FormInstance) => JSX.Element | React.ReactNode;

export interface FormProps<Values = any> extends BaseFormProps {
  initialValues?: Store;
  form?: FormInstance<Values>;
  children?: RenderProps | React.ReactNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component?: false | string | React.FC<any> | React.ComponentClass<any>;
  fields?: FieldData[];
  name?: string;
  validateMessages?: ValidateMessages;
  onValuesChange?: Callbacks<Values>['onValuesChange'];
  onFieldsChange?: Callbacks<Values>['onFieldsChange'];
  onFinish?: Callbacks<Values>['onFinish'];
  onFinishFailed?: Callbacks<Values>['onFinishFailed'];
  validateTrigger?: string | string[] | false;
  preserve?: boolean;
}

// internalForm
const Form: React.ForwardRefRenderFunction<FormInstance, FormProps> = (
  {
    name,
    initialValues,
    fields,
    form,
    preserve,
    children,
    component: Component = 'form',
    validateMessages,
    validateTrigger = 'onChange',
    onValuesChange,
    onFieldsChange,
    onFinish,
    onFinishFailed,
    ...restProps
  }: FormProps,
  ref,
) => {
  const formContext: FormContextProps = React.useContext(FormContext); //? 这里使用到的FormContext 是一些函数的占位符, 没有具体执行的内容

  // We customize handle event since Context will makes all the consumer re-render:
  // https://reactjs.org/docs/context.html#contextprovider
  const [formInstance] = useForm(form); // 单例模式 将外界useForm 生成的 formInstance ,再次调用useForm 返回的内容是一样的
  const {
    useSubscribe,
    setInitialValues,
    setCallbacks,
    setValidateMessages,
    setPreserve,
    destroyForm,
  } = (formInstance as InternalFormInstance).getInternalHooks(HOOK_MARK); // 通过一个特殊标志位(symbol) 获取实例上的私有方法, 很好的隔离 私有方法 和 公共方法

  // Pass ref with form instance
  React.useImperativeHandle(ref, () => formInstance); // 接收ref 暴漏formInstance

  // Register form into Context
  React.useEffect(() => {
    formContext.registerForm(name, formInstance); // ? 有效果么
    return () => {
      formContext.unregisterForm(name);
    };
  }, [formContext, formInstance, name]);

  // Pass props to store
  setValidateMessages({
    ...formContext.validateMessages,
    ...validateMessages,
  }); // 外界可以通过validateMessages自定义 校验的模板 
  setCallbacks({
    onValuesChange,
    onFieldsChange: (changedFields: FieldData[], ...rest) => {
      formContext.triggerFormChange(name, changedFields);

      if (onFieldsChange) {
        onFieldsChange(changedFields, ...rest);
      }
    },
    onFinish: (values: Store) => {
      formContext.triggerFormFinish(name, values);

      if (onFinish) {
        onFinish(values);
      }
    },
    onFinishFailed,
  });
  setPreserve(preserve);

  // Set initial value, init store value when first mount
  const mountRef = React.useRef(null); 
  setInitialValues(initialValues, !mountRef.current);
  if (!mountRef.current) {
    mountRef.current = true;
  }

  React.useEffect(
    () => destroyForm,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Prepare children by `children` type
  let childrenNode: React.ReactNode;
  const childrenRenderProps = typeof children === 'function';  // 如果Form 的children 是 函数 暴露几个参数
  // <Form>
  //     {
  //       (values, formInstance) => {
  // 
  //       }
  //     }
  // </Form>
  if (childrenRenderProps) {
    const values = formInstance.getFieldsValue(true);
    childrenNode = (children as RenderProps)(values, formInstance);
  } else {
    childrenNode = children;
  }

  // Not use subscribe when using render props
  useSubscribe(!childrenRenderProps); // TODO: 什么用

  // Listen if fields provided. We use ref to save prev data here to avoid additional render
  const prevFieldsRef = React.useRef<FieldData[] | undefined>();
  React.useEffect(() => {
    if (!isSimilar(prevFieldsRef.current || [], fields || [])) {
      formInstance.setFields(fields || []);
    }
    prevFieldsRef.current = fields;
  }, [fields, formInstance]);

  const formContextValue = React.useMemo(
    () => ({
      ...(formInstance as InternalFormInstance),
      validateTrigger,
    }),
    [formInstance, validateTrigger],
  ); 

  const wrapperNode = (
    // FieldContext 承载了 formContextValue (formInstance + validateTrigger)  给子组件使用
    <FieldContext.Provider value={formContextValue}>{childrenNode}</FieldContext.Provider>
  );

  if (Component === false) {
    // 使用者显式声明Component : false  
    // TODO: 外层不在使用form 接管数据  主要是 submit onReset 函数 会受到影响么? 
    return wrapperNode;
  }

  return (
    <Component
      {...restProps}
      onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        event.stopPropagation();

        formInstance.submit();
      }}
      onReset={(event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        formInstance.resetFields();
        restProps.onReset?.(event);
      }}
    >
      {wrapperNode}
    </Component>
  );
};

export default Form;
